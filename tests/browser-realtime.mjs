#!/usr/bin/env node
/**
 * A realtime session over real WebRTC, in headless Chromium: the WebRTC transport from the built
 * package negotiates with a second peer connection in the page that plays the provider. The page
 * exchanges a real SDP offer and answer, gathers ICE on loopback, and opens the data channel with
 * DTLS and SCTP. The microphone (Chromium's fake device) is sent up; the provider sends a tone back
 * as the model's audio track, and a second session, with no microphone, still hears it. A tool call
 * runs in the page, and its result reaches the provider. Text
 * turns time the round trip from `sendText()` to the response starting, over the data channel.
 *
 * Held: every turn's round trip under 50 ms at p95 on loopback, the microphone and the model's
 * audio both flowing, and the tool's result delivered. Nothing is installed for it; it uses the
 * Chromium-family browser the machine has, or `CHROME_BIN`.
 *
 *   node tests/browser-realtime.mjs     # needs `npm run build`
 *
 * Without a browser it says so and passes, except under CI, where a missing browser fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TURNS = 30;
const RTT_P95_MS = 50;

function browser() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>A realtime session over WebRTC</title>
<script type="module">
const report = (value) => fetch('/result', { method: 'POST', body: JSON.stringify(value) });
try {
  const { createRealtimeSession, defineTool, OpenAIWebRTCTransport } = await import('/dist/realtime/index.js');

  // The provider's side of a call: a peer connection of its own, sending a tone as the model's voice,
  // and a session endpoint, here answered by it in the page, as your server forwards the offer.
  const context = new AudioContext();
  const providerFor = () => {
    const peer = new RTCPeerConnection();
    const tone = context.createOscillator();
    const voice = context.createMediaStreamDestination();
    tone.connect(voice);
    tone.start();
    peer.addTrack(voice.stream.getAudioTracks()[0], voice.stream);
    const side = { microphone: [], outputs: [], responses: 0, channel: undefined, peer };
    peer.ontrack = (event) => side.microphone.push(event.track.kind);
    side.send = (event) => side.channel.send(JSON.stringify(event));
    const onClient = (event) => {
      if (event.type === 'session.update') side.send({ type: 'session.updated', session: event.session });
      if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output') side.outputs.push(event.item.output);
      if (event.type === 'response.create') {
        const id = 'resp_' + (side.responses += 1);
        side.send({ type: 'response.created', response: { id } });
        side.send({ type: 'response.output_audio_transcript.done', response_id: id, item_id: id + '_item', transcript: side.outputs.length ? 'Order 42 shipped on Monday.' : 'pong' });
        side.send({ type: 'response.done', response: { id, status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 5 } } });
      }
    };
    peer.ondatachannel = (event) => {
      side.channel = event.channel;
      side.channel.onmessage = (message) => onClient(JSON.parse(message.data));
      side.channel.onopen = () => side.send({ type: 'session.created', session: { id: 'sess_browser' } });
    };
    const gathered = () =>
      new Promise((resolve) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        peer.addEventListener('icegatheringstatechange', () => peer.iceGatheringState === 'complete' && resolve());
      });
    side.endpoint = async (_url, init) => {
      await peer.setRemoteDescription({ type: 'offer', sdp: String(init.body) });
      await peer.setLocalDescription(await peer.createAnswer());
      await gathered();
      return new Response(peer.localDescription.sdp, { status: 201, headers: { 'content-type': 'application/sdp' } });
    };
    return side;
  };
  const waitFor = async (check) => {
    const deadline = performance.now() + 5000;
    while (!check() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return check();
  };

  const provider = providerFor();
  const send = provider.send;
  const outputs = provider.outputs;
  const microphone = provider.microphone;

  const looked = [];
  const trackOrder = defineTool({
    name: 'track_order',
    description: 'Where an order is',
    parameters: { type: 'object', properties: { order: { type: 'number' } }, required: ['order'] },
    execute: async ({ order }) => {
      looked.push(order);
      return { status: 'shipped', day: 'Monday' };
    },
  });
  const element = new Audio();
  element.autoplay = true;
  const session = createRealtimeSession({
    model: 'gpt-realtime',
    transport: new OpenAIWebRTCTransport({ sessionEndpoint: '/session', fetch: provider.endpoint }),
    tools: [trackOrder],
    conversation: { captureTranscripts: true },
    // Chromium's fake microphone, granted without a prompt.
    connection: { microphone: true, audioElement: element },
  });
  let modelAudio = false;
  session.on('assistant.audio.track', () => {
    modelAudio = true;
  });
  const connectStarted = performance.now();
  await session.connect();
  const connectMs = performance.now() - connectStarted;

  // Text turns, timed from sendText() to the response starting.
  const rtts = [];
  for (let turn = 0; turn < ${TURNS}; turn += 1) {
    const started = performance.now();
    const created = new Promise((resolve) => session.once('assistant.response.created', resolve));
    session.sendText('ping ' + turn);
    await created;
    rtts.push(performance.now() - started);
    await session.whenIdle();
  }

  // The model calls a tool; the page runs it, and its result reaches the provider.
  send({
    type: 'response.done',
    response: { id: 'resp_tool', status: 'completed', output: [
      { type: 'function_call', call_id: 'call_1', name: 'track_order', arguments: JSON.stringify({ order: 42 }) },
    ] },
  });
  await waitFor(() => outputs.length > 0);
  await session.whenIdle();
  await waitFor(() => modelAudio && microphone.length > 0);
  await waitFor(() => element.srcObject instanceof MediaStream && !element.paused);
  const playing = element.srcObject instanceof MediaStream && !element.paused;
  const conversation = session.getConversation();
  await session.disconnect();

  // A session that sends no microphone still hears the model.
  const listener = providerFor();
  const quiet = createRealtimeSession({
    model: 'gpt-realtime',
    transport: new OpenAIWebRTCTransport({ sessionEndpoint: '/session', fetch: listener.endpoint }),
    connection: { audioElement: new Audio() },
  });
  let heard = false;
  quiet.on('assistant.audio.track', () => {
    heard = true;
  });
  await quiet.connect();
  await waitFor(() => heard);
  await quiet.disconnect();
  rtts.sort((a, b) => a - b);
  report({
    ok: true,
    connectMs,
    rttP50: rtts[Math.floor(rtts.length * 0.5)],
    rttP95: rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * 0.95))],
    microphone,
    modelAudio,
    listenOnly: { heard, microphone: listener.microphone },
    playing,
    looked,
    outputs,
    spoken: conversation.items.filter((item) => item.type === 'assistant_speech').map((item) => item.transcript),
    toolCalls: conversation.items.filter((item) => item.type === 'tool_call').length,
    userAgent: navigator.userAgent,
  });
} catch (error) {
  const causes = [];
  for (let cause = error; cause; cause = cause.cause) causes.push(String(cause.code ?? '') + ' ' + String(cause.message ?? cause));
  report({ ok: false, error: String((error && error.stack) || error) + '\\n  caused by: ' + causes.join('\\n  caused by: ') });
}
</script>`;

const executable = browser();
if (!executable) {
  const message = 'No Chromium-family browser found; set CHROME_BIN to run the WebRTC check.';
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipped.`);
  process.exit(0);
}
if (!existsSync(path.join(root, 'dist', 'realtime', 'index.js'))) throw new Error('Build first: npm run build');

let resolveResult;
const reported = new Promise((resolve) => {
  resolveResult = resolve;
});
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  if (url.pathname === '/result' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      response.writeHead(204);
      response.end();
      resolveResult(JSON.parse(body));
    });
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(path.join(root, 'dist')) || !existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/json',
  });
  response.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const profile = path.join(root, '.tmp-nexus-ai-tests', `browser-realtime-${process.pid}`);
const child = spawn(
  executable,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    // A fake microphone, granted without a prompt, and audio that plays without a gesture.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Loopback candidates as addresses, not mDNS names a CI container may not resolve.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), 60_000));
const result = await Promise.race([reported, timeout]);
child.kill();
server.close();
await new Promise((resolve) => setTimeout(resolve, 200));
rmSync(profile, { recursive: true, force: true, maxRetries: 3 });

if (!result) {
  console.error(`The browser did not report a result within 60 s:\n${stderr.slice(-2_000)}`);
  process.exit(1);
}
if (!result.ok) {
  console.error(`In the browser: ${result.error}`);
  process.exit(1);
}
const failures = [];
if (!(result.rttP95 < RTT_P95_MS))
  failures.push(`a turn's round trip was ${result.rttP95.toFixed(1)} ms at p95, past ${RTT_P95_MS} ms`);
if (!result.microphone.includes('audio')) failures.push('the provider never received the microphone');
if (!result.modelAudio || !result.playing) failures.push("the model's audio never reached the page's player");
if (!result.listenOnly.heard) failures.push('a session without a microphone never heard the model');
if (result.listenOnly.microphone.length) failures.push('a session without a microphone sent audio');
if (JSON.stringify(result.looked) !== '[42]') failures.push(`the tool ran with ${JSON.stringify(result.looked)}`);
if (!result.outputs.some((output) => output.includes('shipped')))
  failures.push("the tool's result never reached the provider");
if (result.toolCalls !== 1) failures.push(`the record holds ${result.toolCalls} tool calls`);
if (!result.spoken.includes('Order 42 shipped on Monday.'))
  failures.push("the model's answer after the tool is not in the record");
if (result.spoken.filter((text) => text === 'pong').length !== TURNS) failures.push('not every text turn was answered');
if (failures.length) {
  console.error(`The WebRTC check failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `In ${result.userAgent.match(/(HeadlessChrome|Chrome|Edg)\/[\d.]+/)?.[0] ?? 'the browser'}, over WebRTC: connected in ${result.connectMs.toFixed(0)} ms; ${TURNS} turns at ${result.rttP50.toFixed(1)} ms p50 and ${result.rttP95.toFixed(1)} ms p95 round trip; microphone up, the model's audio down, and a tool call answered.`,
);
