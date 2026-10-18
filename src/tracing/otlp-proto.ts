/**
 * OTLP's protobuf encoding of a trace export, written by hand: an `ExportTraceServiceRequest` from
 * `opentelemetry/proto/collector/trace/v1`, and the partial success its response may carry. What
 * OTLP over gRPC sends, and OTLP/HTTP with `application/x-protobuf`. It runs anywhere: it needs
 * nothing but `TextEncoder`.
 */
import type { OtlpExportRequest, OtlpKeyValue, OtlpSpan } from './otlp.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A protobuf writer: fields appended in order, each message measured once it is written. */
class Writer {
  private buffer: Uint8Array;
  private length = 0;

  constructor(size = 256) {
    this.buffer = new Uint8Array(size);
  }

  private reserve(bytes: number): void {
    if (this.length + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + bytes) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  /** An unsigned varint, up to 2^53 as a number or any 64-bit value as a bigint. */
  varint(value: number | bigint): void {
    this.reserve(10);
    if (typeof value === 'number' && value < 0x80000000) {
      let rest = value >>> 0;
      while (rest > 0x7f) {
        this.buffer[this.length++] = (rest & 0x7f) | 0x80;
        rest >>>= 7;
      }
      this.buffer[this.length++] = rest;
      return;
    }
    let rest = BigInt.asUintN(64, BigInt(value));
    while (rest > 0x7fn) {
      this.buffer[this.length++] = Number(rest & 0x7fn) | 0x80;
      rest >>= 7n;
    }
    this.buffer[this.length++] = Number(rest);
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  bytes(field: number, value: Uint8Array): void {
    this.tag(field, 2);
    this.varint(value.length);
    this.reserve(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  string(field: number, value: string): void {
    if (value) this.bytes(field, encoder.encode(value));
  }

  uint(field: number, value: number | bigint): void {
    this.tag(field, 0);
    this.varint(value);
  }

  bool(field: number, value: boolean): void {
    this.uint(field, value ? 1 : 0);
  }

  fixed64(field: number, value: bigint): void {
    this.tag(field, 1);
    this.reserve(8);
    new DataView(this.buffer.buffer, this.buffer.byteOffset).setBigUint64(this.length, BigInt.asUintN(64, value), true);
    this.length += 8;
  }

  double(field: number, value: number): void {
    this.tag(field, 1);
    this.reserve(8);
    new DataView(this.buffer.buffer, this.buffer.byteOffset).setFloat64(this.length, value, true);
    this.length += 8;
  }

  message(field: number, write: (writer: Writer) => void): void {
    const inner = new Writer(64);
    write(inner);
    this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

function hex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length >>> 1);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function keyValue(writer: Writer, attribute: OtlpKeyValue): void {
  writer.string(1, attribute.key);
  writer.message(2, (value) => {
    const any = attribute.value;
    if ('stringValue' in any) value.bytes(1, encoder.encode(any.stringValue));
    else if ('boolValue' in any) value.bool(2, any.boolValue);
    else if ('intValue' in any) value.uint(3, BigInt(any.intValue));
    else value.double(4, any.doubleValue);
  });
}

function span(writer: Writer, item: OtlpSpan): void {
  writer.bytes(1, hex(item.traceId));
  writer.bytes(2, hex(item.spanId));
  if (item.parentSpanId) writer.bytes(4, hex(item.parentSpanId));
  writer.string(5, item.name);
  writer.uint(6, item.kind);
  writer.fixed64(7, BigInt(item.startTimeUnixNano));
  writer.fixed64(8, BigInt(item.endTimeUnixNano));
  for (const attribute of item.attributes) writer.message(9, (inner) => keyValue(inner, attribute));
  writer.message(15, (status) => {
    if (item.status.message) status.string(2, item.status.message);
    status.uint(3, item.status.code);
  });
}

/**
 * An export request in OTLP's protobuf encoding, as a collector takes it over gRPC or OTLP/HTTP with
 * `content-type: application/x-protobuf`.
 */
export function encodeOtlpTraceRequest(request: OtlpExportRequest): Uint8Array {
  const writer = new Writer(1024);
  for (const resourceSpans of request.resourceSpans) {
    writer.message(1, (resource) => {
      resource.message(1, (inner) => {
        for (const attribute of resourceSpans.resource.attributes) inner.message(1, (kv) => keyValue(kv, attribute));
      });
      for (const scopeSpans of resourceSpans.scopeSpans) {
        resource.message(2, (scope) => {
          scope.message(1, (inner) => {
            inner.string(1, scopeSpans.scope.name);
            if (scopeSpans.scope.version) inner.string(2, scopeSpans.scope.version);
          });
          for (const item of scopeSpans.spans) scope.message(2, (inner) => span(inner, item));
        });
      }
    });
  }
  return writer.finish();
}

/** What a collector says it rejected of an export it otherwise took, from OTLP's partial success. */
export interface OtlpPartialSuccess {
  /** Spans it rejected. */
  rejectedSpans: number;
  /** Why, in its words. */
  errorMessage?: string;
}

/**
 * Reads an `ExportTraceServiceResponse` in the protobuf encoding: its partial success, or nothing
 * when the collector took every span.
 */
export function decodeOtlpTraceResponse(bytes: Uint8Array): OtlpPartialSuccess | undefined {
  const outer = fields(bytes);
  const partial = outer.find((field) => field.number === 1 && field.bytes);
  if (!partial?.bytes) return undefined;
  let rejectedSpans = 0;
  let errorMessage: string | undefined;
  for (const field of fields(partial.bytes)) {
    if (field.number === 1 && field.varint !== undefined) rejectedSpans = Number(field.varint);
    if (field.number === 2 && field.bytes) errorMessage = decoder.decode(field.bytes);
  }
  if (rejectedSpans === 0 && !errorMessage) return undefined;
  return { rejectedSpans, ...(errorMessage ? { errorMessage } : {}) };
}

/** The top-level fields of a protobuf message: varints and length-delimited ones, the rest skipped. */
function fields(bytes: Uint8Array): Array<{ number: number; varint?: bigint; bytes?: Uint8Array }> {
  const found: Array<{ number: number; varint?: bigint; bytes?: Uint8Array }> = [];
  let at = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= bytes.length) throw new Error('A protobuf varint ran past the end of the message');
      const byte = bytes[at++] as number;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7n;
    }
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) found.push({ number, varint: varint() });
    else if (wire === 2) {
      const length = Number(varint());
      found.push({ number, bytes: bytes.subarray(at, at + length) });
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error(`A protobuf field used wire type ${wire}, which OTLP does not`);
  }
  return found;
}
