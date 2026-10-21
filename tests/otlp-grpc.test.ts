/**
 * OTLP over gRPC, and OTLP/HTTP in the protobuf encoding, proved two ways.
 *
 * Against a gRPC server of the test's own, with a protobuf reader written apart from the encoder: the
 * spans arrive as `runToOtlpSpan()` describes them, compressed, with their metadata; a refusal, a
 * deadline, a partial success, and a collector that is down are each reported as they should be,
 * and a spool keeps what a collector that is down refuses.
 *
 * Against the OpenTelemetry Collector itself, in a container: it takes the spans over gRPC and sends
 * them on as OTLP/HTTP JSON to a server of the test's, which finds every one as it was sent. That
 * needs `docker` or `podman` with a running daemon; without one it is skipped, unless
 * `NEXUS_REQUIRE_CONTAINER=1` makes that a failure. `NEXUS_OTEL_COLLECTOR_IMAGE` chooses the image.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { after, test } from 'node:test';
import { MemoryOperationStore } from '../src/operations/store.js';
import { OtlpGrpcError, OtlpGrpcTraceExporter } from '../src/tracing/otlp-grpc.js';
import { OtlpPartialSuccessError, OtlpTraceExporter, runToOtlpSpan } from '../src/tracing/otlp.js';
import { spoolingExporter } from '../src/tracing/spool.js';
import type { OperationStore } from '../src/types/operations.js';
import type { Run } from '../src/types/tracing.js';

// ── A protobuf reader of the test's own, so the encoder is never checked against itself ──

type Field = { number: number; wire: number; value: bigint | Uint8Array };

function parse(bytes: Uint8Array): Field[] {
  const fields: Field[] = [];
  let at = 0;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= bytes.length) throw new Error('a varint ran past the end');
      const byte = bytes[at++] as number;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const wire = key & 7;
    const number = key >>> 3;
    if (wire === 0) fields.push({ number, wire, value: varint() });
    else if (wire === 1) {
      fields.push({ number, wire, value: bytes.subarray(at, at + 8) });
      at += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      fields.push({ number, wire, value: bytes.subarray(at, at + length) });
      at += length;
    } else throw new Error(`unexpected wire type ${wire}`);
  }
  return fields;
}
const all = (fields: Field[], number: number) => fields.filter((field) => field.number === number);
const one = (fields: Field[], number: number) => all(fields, number)[0];
const text = (field?: Field) => (field ? new TextDecoder().decode(field.value as Uint8Array) : undefined);
const hexOf = (field?: Field) => (field ? Buffer.from(field.value as Uint8Array).toString('hex') : undefined);
const fixed64 = (field?: Field) =>
  field ? new DataView((field.value as Uint8Array).slice().buffer).getBigUint64(0, true).toString() : undefined;

function attribute(bytes: Uint8Array) {
  const fields = parse(bytes);
  const value = parse(one(fields, 2)?.value as Uint8Array);
  const [field] = value;
  let typed: Record<string, unknown> = {};
  if (field?.number === 1) typed = { stringValue: text(field) };
  if (field?.number === 2) typed = { boolValue: field.value === 1n };
  if (field?.number === 3) typed = { intValue: BigInt.asIntN(64, field.value as bigint).toString() };
  if (field?.number === 4) {
    typed = { doubleValue: new DataView((field.value as Uint8Array).slice().buffer).getFloat64(0, true) };
  }
  return { key: text(one(fields, 1)), value: typed };
}

function decodeRequest(bytes: Uint8Array) {
  return all(parse(bytes), 1).map((resourceSpans) => {
    const resource = parse(resourceSpans.value as Uint8Array);
    return {
      resource: all(parse(one(resource, 1)?.value as Uint8Array), 1).map((field) =>
        attribute(field.value as Uint8Array),
      ),
      scopeSpans: all(resource, 2).map((scopeSpans) => {
        const scope = parse(scopeSpans.value as Uint8Array);
        return {
          scope: text(one(parse(one(scope, 1)?.value as Uint8Array), 1)),
          spans: all(scope, 2).map((spanField) => {
            const span = parse(spanField.value as Uint8Array);
            const status = parse((one(span, 15)?.value as Uint8Array) ?? new Uint8Array(0));
            const parent = hexOf(one(span, 4));
            const message = text(one(status, 2));
            // Span.Event 11 (time 1, name 2, attributes 3), dropped events 12, Span.Link 13 (ids 1 and 2, attributes 4).
            const events = all(span, 11).map((field) => {
              const event = parse(field.value as Uint8Array);
              return {
                timeUnixNano: fixed64(one(event, 1)),
                name: text(one(event, 2)),
                attributes: all(event, 3).map((item) => attribute(item.value as Uint8Array)),
              };
            });
            const dropped = Number(one(span, 12)?.value ?? 0);
            const links = all(span, 13).map((field) => {
              const link = parse(field.value as Uint8Array);
              return {
                traceId: hexOf(one(link, 1)),
                spanId: hexOf(one(link, 2)),
                attributes: all(link, 4).map((item) => attribute(item.value as Uint8Array)),
              };
            });
            return {
              traceId: hexOf(one(span, 1)),
              spanId: hexOf(one(span, 2)),
              ...(parent ? { parentSpanId: parent } : {}),
              name: text(one(span, 5)),
              kind: Number(one(span, 6)?.value ?? 0),
              startTimeUnixNano: fixed64(one(span, 7)),
              endTimeUnixNano: fixed64(one(span, 8)),
              attributes: all(span, 9).map((field) => attribute(field.value as Uint8Array)),
              ...(events.length ? { events } : {}),
              ...(dropped ? { droppedEventsCount: dropped } : {}),
              ...(links.length ? { links } : {}),
              status: { code: Number(one(status, 3)?.value ?? 0), ...(message ? { message } : {}) },
            };
          }),
        };
      }),
    };
  });
}

/** An `ExportTraceServiceResponse` with a partial success, encoded by hand. */
function partialSuccess(rejected: number, message: string): Uint8Array {
  const text = new TextEncoder().encode(message);
  const inner = Uint8Array.from([0x08, rejected, 0x12, text.length, ...text]);
  return Uint8Array.from([0x0a, inner.length, ...inner]);
}

// ── Runs to send ──

const at = Date.parse('2026-10-18T12:00:00.000Z');
const iso = (offset: number) => new Date(at + offset).toISOString();
const runs: Run[] = [
  {
    id: 'run-0000000000000001',
    traceId: 'trace-00000000000000000000000000000abc',
    name: 'support',
    kind: 'agent',
    status: 'ok',
    startedAt: iso(0),
    endedAt: iso(900),
    tags: ['canary'],
    // The run that queued it, in another trace.
    links: [
      {
        traceId: 'trace-00000000000000000000000000000fed',
        runId: 'run-00000000000000ff',
        attributes: { 'nexus.link': 'queued_by' },
      },
    ],
  },
  {
    id: 'run-0000000000000002',
    traceId: 'trace-00000000000000000000000000000abc',
    parentId: 'run-0000000000000001',
    name: 'model',
    kind: 'model',
    model: 'gpt-5',
    provider: 'openai',
    status: 'error',
    error: { name: 'RateLimitError', message: 'slow down — 速度' },
    startedAt: iso(10),
    endedAt: iso(400),
    usage: { inputTokens: 1200, outputTokens: 3 },
    cost: 0.0125,
    events: [
      {
        name: 'retry',
        time: iso(120),
        attributes: { 'gen_ai.provider.name': 'openai', 'error.message': 'rate limited', 'nexus.attempt': 2 },
      },
      { name: 'guardrail', time: iso(390), attributes: { 'nexus.guardrail': 'pii-redaction' } },
    ],
    droppedEvents: 3,
  },
];

const span = (fields: Partial<Run>, n: number): Run => ({
  id: `run-${String(n).padStart(16, '0')}`,
  traceId: 'trace-00000000000000000000000000000def',
  name: `step-${n}`,
  kind: 'chain',
  status: 'ok',
  startedAt: iso(n),
  endedAt: iso(n + 5),
  ...fields,
});

// ── A gRPC trace service of the test's own ──

interface Received {
  headers: http2.IncomingHttpHeaders;
  request: ReturnType<typeof decodeRequest>;
}

type Behaviour =
  | { kind: 'ok' }
  | { kind: 'refuse'; code: number; message: string }
  | { kind: 'partial'; rejected: number; message: string }
  | { kind: 'hang' };

async function grpcCollector(port = 0) {
  const received: Received[] = [];
  const state: { behaviour: Behaviour } = { behaviour: { kind: 'ok' } };
  const server = http2.createServer();
  // A collector that stops drops its connections, as a real one does.
  const sessions = new Set<http2.ServerHttp2Session>();
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket: import('node:net').Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const behaviour = state.behaviour;
      if (behaviour.kind === 'hang') return;
      const body = Buffer.concat(chunks);
      const payload = body.subarray(5, 5 + body.readUInt32BE(1));
      const message = body[0] === 1 ? gunzipSync(payload) : payload;
      received.push({ headers, request: decodeRequest(new Uint8Array(message)) });
      if (behaviour.kind === 'refuse') {
        // Trailers-only, as a gRPC server refuses a call.
        stream.respond({
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': String(behaviour.code),
          'grpc-message': encodeURIComponent(behaviour.message),
        });
        stream.end();
        return;
      }
      const reply =
        behaviour.kind === 'partial' ? partialSuccess(behaviour.rejected, behaviour.message) : new Uint8Array(0);
      const frame = Buffer.alloc(5 + reply.length);
      frame.writeUInt32BE(reply.length, 1);
      frame.set(reply, 5);
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(frame);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const bound = (server.address() as AddressInfo).port;
  return {
    received,
    state,
    port: bound,
    endpoint: `http://127.0.0.1:${bound}`,
    close: (options: { abrupt?: boolean } = {}) =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Abrupt: the connections drop with no word to the client, as when a collector dies.
        if (options.abrupt) for (const socket of sockets) socket.destroy();
        else for (const session of sessions) session.destroy();
      }),
  };
}

const exporters: OtlpGrpcTraceExporter[] = [];
const open = (options: ConstructorParameters<typeof OtlpGrpcTraceExporter>[0]) => {
  const exporter = new OtlpGrpcTraceExporter(options);
  exporters.push(exporter);
  return exporter;
};
after(async () => {
  await Promise.all(exporters.map((exporter) => exporter.close()));
});

test('spans reach a gRPC collector as runToOtlpSpan() describes them, compressed, with their metadata', async () => {
  const collector = await grpcCollector();
  try {
    const exporter = open({
      endpoint: collector.endpoint,
      headers: { 'X-Api-Key': 'secret' },
      serviceName: 'support-api',
      resource: { 'deployment.environment.name': 'test', 'service.instance.count': 3, sampled: true },
    });
    await exporter.send(runs);
    const [call] = collector.received;
    assert.ok(call, 'one call');
    assert.equal(call.headers[':path'], '/opentelemetry.proto.collector.trace.v1.TraceService/Export');
    assert.equal(call.headers['content-type'], 'application/grpc');
    assert.equal(call.headers['grpc-encoding'], 'gzip');
    assert.equal(call.headers.te, 'trailers');
    assert.equal(call.headers['x-api-key'], 'secret');
    assert.match(String(call.headers['grpc-timeout']), /^\d+m$/);
    const [resourceSpans] = call.request;
    assert.deepEqual(resourceSpans?.resource, [
      { key: 'service.name', value: { stringValue: 'support-api' } },
      { key: 'deployment.environment.name', value: { stringValue: 'test' } },
      { key: 'service.instance.count', value: { intValue: '3' } },
      { key: 'sampled', value: { boolValue: true } },
    ]);
    assert.equal(resourceSpans?.scopeSpans[0]?.scope, 'nexus-ai-pro');
    assert.deepEqual(
      resourceSpans?.scopeSpans[0]?.spans,
      runs.map(runToOtlpSpan),
      'every field, from ids and times to typed attributes and status',
    );

    // Uncompressed too, and through flush(), batch by batch.
    const plain = open({ endpoint: collector.endpoint, gzip: false, maxBatch: 2 });
    for (let n = 0; n < 5; n += 1) plain.export(span({}, n));
    await plain.flush();
    const plainCalls = collector.received.slice(1);
    assert.deepEqual(
      plainCalls.map((item) => [item.headers['grpc-encoding'], item.request[0]?.scopeSpans[0]?.spans.length]),
      [
        [undefined, 2],
        [undefined, 2],
        [undefined, 1],
      ],
    );
  } finally {
    await collector.close();
  }
});

test('a refusal, a deadline, a partial success, and a collector that is down are each reported', async () => {
  const collector = await grpcCollector();
  const errors: unknown[] = [];
  const exporter = open({ endpoint: collector.endpoint, timeoutMs: 300, onError: (error) => errors.push(error) });
  try {
    collector.state.behaviour = { kind: 'refuse', code: 14, message: 'the queue is full' };
    await assert.rejects(exporter.send([span({}, 1)]), (error: unknown) => {
      assert.ok(error instanceof OtlpGrpcError, 'a gRPC error');
      assert.deepEqual([error.code, error.details], [14, 'the queue is full']);
      assert.match(error.message, /UNAVAILABLE: the queue is full/);
      return true;
    });

    collector.state.behaviour = { kind: 'partial', rejected: 2, message: 'span names too long' };
    await exporter.send([span({}, 2), span({}, 3)]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof OtlpPartialSuccessError, 'a partial success is reported, not thrown');
    assert.deepEqual(
      [(errors[0] as OtlpPartialSuccessError).rejectedSpans, (errors[0] as OtlpPartialSuccessError).errorMessage],
      [2, 'span names too long'],
    );

    collector.state.behaviour = { kind: 'hang' };
    const started = Date.now();
    await assert.rejects(exporter.send([span({}, 4)]), (error: unknown) => {
      assert.ok(error instanceof OtlpGrpcError && error.code === 4, 'DEADLINE_EXCEEDED');
      return true;
    });
    assert.ok(Date.now() - started < 3_000, 'within its deadline');

    // On its own, a refused batch goes to onError.
    collector.state.behaviour = { kind: 'refuse', code: 8, message: 'over quota' };
    exporter.export(span({}, 5));
    await exporter.flush();
    assert.ok(errors.at(-1) instanceof OtlpGrpcError, 'flush reports, never throws');
  } finally {
    await collector.close();
  }
  // The collector is gone: the connection is refused, and the next call opens a new one.
  await assert.rejects(exporter.send([span({}, 6)]), /ECONNREFUSED|ECONNRESET|closed|GOAWAY/);
});

test('a collector that restarts gets the next call on a connection of its own', async () => {
  const first = await grpcCollector();
  const exporter = open({ endpoint: first.endpoint });
  await exporter.send([span({}, 1)]);
  await first.close({ abrupt: true });
  const second = await grpcCollector(first.port);
  // Sent at once, before the client has noticed the drop: made again on a new connection.
  await exporter.send([span({}, 2)]);
  await second.close({ abrupt: true });
  const third = await grpcCollector(first.port);
  try {
    // Sent once the client has seen the connection close: a new one from the start.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await exporter.send([span({}, 3)]);
    assert.deepEqual(
      [...second.received, ...third.received].map((call) => call.request[0]?.scopeSpans[0]?.spans[0]?.name),
      ['step-2', 'step-3'],
      'each restarted collector took its call',
    );
  } finally {
    await third.close();
  }
});

test('a spool keeps what a gRPC collector that is down refuses, and delivers it once it is back', async () => {
  const collector = await grpcCollector();
  collector.state.behaviour = { kind: 'refuse', code: 14, message: 'starting up' };
  let clock = at;
  const spool = spoolingExporter({
    sender: open({ endpoint: collector.endpoint }),
    store: new MemoryOperationStore() as unknown as OperationStore,
    drainEveryMs: 0,
    maxBatch: 10,
    now: () => clock,
  });
  try {
    for (let n = 0; n < 50; n += 1) spool.export(span({}, n));
    await spool.flush();
    assert.equal((await spool.stats()).pendingBatches, 5);
    collector.state.behaviour = { kind: 'ok' };
    clock += 60_000;
    await spool.drain();
    const delivered = collector.received
      .slice(5)
      .flatMap((call) => call.request[0]?.scopeSpans[0]?.spans.map((item) => item.name) ?? []);
    assert.equal(delivered.length, 50);
    assert.equal(new Set(delivered).size, 50, 'each span once');
    assert.equal((await spool.stats()).pendingBatches, 0);
  } finally {
    await spool.close();
    await collector.close();
  }
});

test('OTLP/HTTP in the protobuf encoding carries the same spans', async () => {
  const bodies: Array<{ type: string | null; body: Uint8Array }> = [];
  const errors: unknown[] = [];
  const exporter = new OtlpTraceExporter({
    endpoint: 'https://collector.test:4318',
    protocol: 'http/protobuf',
    onError: (error) => errors.push(error),
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push({ type: new Headers(init.headers).get('content-type'), body: init.body as Uint8Array });
      return new Response(new Blob([partialSuccess(1, 'one too many')]), { status: 200 });
    }) as typeof fetch,
  });
  await exporter.send(runs);
  assert.equal(bodies[0]?.type, 'application/x-protobuf');
  assert.deepEqual(decodeRequest(bodies[0]?.body as Uint8Array)[0]?.scopeSpans[0]?.spans, runs.map(runToOtlpSpan));
  assert.ok(errors[0] instanceof OtlpPartialSuccessError, 'its partial success is read too');

  // And the JSON encoding reads a partial success from its body.
  const json = new OtlpTraceExporter({
    endpoint: 'https://collector.test:4318',
    onError: (error) => errors.push(error),
    fetch: (async () =>
      new Response(JSON.stringify({ partialSuccess: { rejectedSpans: '4', errorMessage: 'too old' } }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
  await json.send(runs);
  assert.deepEqual(
    [(errors[1] as OtlpPartialSuccessError).rejectedSpans, (errors[1] as OtlpPartialSuccessError).errorMessage],
    [4, 'too old'],
  );
});

test('attribute values keep their types: negative and large integers, doubles, and text in any script', async () => {
  const collector = await grpcCollector();
  try {
    const exporter = open({
      endpoint: collector.endpoint,
      resource: { offset: -42, big: 2 ** 40, ratio: -0.125, label: 'ünïcødé ✓' },
    });
    await exporter.send([span({ cost: 1e-9 }, 1)]);
    const [call] = collector.received;
    assert.deepEqual(call?.request[0]?.resource.slice(1), [
      { key: 'offset', value: { intValue: '-42' } },
      { key: 'big', value: { intValue: String(2 ** 40) } },
      { key: 'ratio', value: { doubleValue: -0.125 } },
      { key: 'label', value: { stringValue: 'ünïcødé ✓' } },
    ]);
    const cost = call?.request[0]?.scopeSpans[0]?.spans[0]?.attributes.find((item) => item.key === 'nexus.cost.usd');
    assert.deepEqual(cost?.value, { doubleValue: 1e-9 });
  } finally {
    await collector.close();
  }
});

// ── The OpenTelemetry Collector itself ──

const binary = process.env.NEXUS_CONTAINER_BINARY ?? 'docker';
const image = process.env.NEXUS_OTEL_COLLECTOR_IMAGE ?? 'otel/opentelemetry-collector:0.111.0';
const required = process.env.NEXUS_REQUIRE_CONTAINER === '1';
const daemon = spawnSync(binary, ['info'], { timeout: 30_000, windowsHide: true, stdio: 'ignore' });
const skip = daemon.status === 0 ? false : `no ${binary} daemon is reachable`;

test('the OpenTelemetry Collector takes the spans over gRPC, and sends on every one as it came', {
  skip: required ? false : skip,
  timeout: 300_000,
}, async () => {
  assert.equal(daemon.status, 0, `NEXUS_REQUIRE_CONTAINER=1, but \`${binary} info\` failed`);
  // Where the collector sends what it takes: OTLP/HTTP JSON, to a server of the test's.
  const forwarded: unknown[] = [];
  const sink = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/v1/traces') forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '0.0.0.0', resolve));
  const sinkPort = (sink.address() as AddressInfo).port;
  // The configuration goes on the command line, so nothing is mounted: any daemon, local or not,
  // runs it as it is.
  const config = [
    'receivers::otlp::protocols::grpc::endpoint: 0.0.0.0:4317',
    `exporters::otlphttp::endpoint: http://host.docker.internal:${sinkPort}`,
    'exporters::otlphttp::encoding: json',
    'exporters::otlphttp::compression: none',
    'exporters::otlphttp::sending_queue::enabled: false',
    'exporters::otlphttp::retry_on_failure::enabled: false',
    'service::telemetry::logs::level: warn',
    'service::pipelines::traces::receivers: [otlp]',
    'service::pipelines::traces::exporters: [otlphttp]',
  ].map((line) => `--config=yaml:${line}`);
  const started = spawnSync(
    binary,
    [
      'run',
      '--detach',
      '--publish',
      '127.0.0.1::4317',
      '--add-host',
      'host.docker.internal:host-gateway',
      image,
      ...config,
    ],
    { encoding: 'utf8', timeout: 240_000, windowsHide: true },
  );
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  const logs = () => {
    const read = spawnSync(binary, ['logs', container], { encoding: 'utf8', windowsHide: true });
    return `${read.stdout}${read.stderr}`;
  };
  try {
    const port = spawnSync(binary, ['port', container, '4317/tcp'], { encoding: 'utf8', windowsHide: true })
      .stdout.trim()
      .split('\n')[0]
      ?.split(':')
      .at(-1);
    assert.match(port ?? '', /^\d+$/, `the collector published no port; it said:\n${logs()}`);
    const exporter = open({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 5_000 });
    const batch = [...runs, ...Array.from({ length: 20 }, (_, n) => span({ kind: n % 2 ? 'tool' : 'node' }, n + 10))];
    // The collector takes a moment to start; until then the call is refused.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await exporter.send(batch);
        break;
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`the collector never took the spans: ${String(error)}\n${logs()}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // Sent on synchronously, with no queue, so the spans are there when the call returns.
    const spans = forwarded.flatMap(
      (body) =>
        (body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> })
          .resourceSpans[0]?.scopeSpans[0]?.spans ?? [],
    );
    assert.equal(spans.length, batch.length, 'every span');
    const expected = batch.map(runToOtlpSpan);
    for (const item of expected) {
      const arrived = spans.find((candidate) => candidate.spanId === item.spanId);
      assert.ok(arrived, `span ${item.name} arrived`);
      assert.deepEqual(
        [
          arrived.traceId,
          arrived.parentSpanId || undefined,
          arrived.name,
          arrived.kind,
          arrived.startTimeUnixNano,
          arrived.endTimeUnixNano,
        ],
        [item.traceId, item.parentSpanId, item.name, item.kind, item.startTimeUnixNano, item.endTimeUnixNano],
        item.name,
      );
      assert.deepEqual(
        new Map(
          (arrived.attributes as Array<{ key: string; value: unknown }>).map((attribute) => [
            attribute.key,
            attribute.value,
          ]),
        ),
        new Map(item.attributes.map((attribute) => [attribute.key, attribute.value])),
        `${item.name}: its attributes`,
      );
      assert.deepEqual(arrived.status, item.status.code === 2 ? item.status : { code: 1 }, `${item.name}: its status`);
      // Its events and links, as the collector forwards them.
      const named = (attributes: Array<{ key: string; value: unknown }> | undefined) =>
        new Map((attributes ?? []).map((attribute) => [attribute.key, attribute.value]));
      const events = (arrived.events as Array<Record<string, unknown>> | undefined) ?? [];
      assert.deepEqual(
        events.map((event) => [event.name, event.timeUnixNano, named(event.attributes as never)]),
        (item.events ?? []).map((event) => [event.name, event.timeUnixNano, named(event.attributes)]),
        `${item.name}: its events`,
      );
      assert.equal(arrived.droppedEventsCount ?? 0, item.droppedEventsCount ?? 0, `${item.name}: its dropped events`);
      const links = (arrived.links as Array<Record<string, unknown>> | undefined) ?? [];
      assert.deepEqual(
        links.map((link) => [link.traceId, link.spanId, named(link.attributes as never)]),
        (item.links ?? []).map((link) => [link.traceId, link.spanId, named(link.attributes)]),
        `${item.name}: its links`,
      );
    }
    const resource = (forwarded[0] as { resourceSpans: Array<{ resource: { attributes: unknown[] } }> })
      .resourceSpans[0]?.resource.attributes;
    assert.deepEqual(resource, [{ key: 'service.name', value: { stringValue: 'nexus-ai-pro' } }]);
  } finally {
    spawnSync(binary, ['rm', '--force', container], { windowsHide: true, timeout: 60_000 });
    sink.close();
  }
});
