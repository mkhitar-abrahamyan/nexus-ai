/**
 * A2A's messages in Protocol Buffers, as `specification/a2a.proto` of protocol 1.0 numbers them
 * (package `lf.a2a.v1`): each turned into, and read from, the JSON the other bindings carry, so the
 * gRPC binding calls the same methods with the same params. With `google.protobuf.Struct`, `Value`,
 * `Timestamp`, and `google.rpc.Status`. Fields the agent never sends, such as a card's security
 * schemes, are read past and not written.
 */

type FieldType =
  | 'string'
  | 'bool'
  | 'int32'
  | 'bytes'
  | 'struct'
  | 'value'
  | 'timestamp'
  | 'stringMap'
  | { enum: readonly string[] }
  | { message: string };

/** One field: its JSON name, its number, its type, and whether it repeats or tracks its presence. */
interface Field {
  json: string;
  number: number;
  type: FieldType;
  repeated?: boolean;
  /** Written even at its default, as proto3's `optional` and a `oneof` member are. */
  presence?: boolean;
  /** A list the specification requires, read as empty when no element came. */
  required?: boolean;
}

const TASK_STATE = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;
const ROLE = ['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT'] as const;

const f = (json: string, number: number, type: FieldType, extra: Partial<Field> = {}): Field => ({
  json,
  number,
  type,
  ...extra,
});
const many = { repeated: true };
const all = { repeated: true, required: true };
const present = { presence: true };

/** Every message the binding sends or reads, by its name in the proto. */
const MESSAGES: Record<string, readonly Field[]> = {
  SendMessageConfiguration: [
    f('acceptedOutputModes', 1, 'string', many),
    f('taskPushNotificationConfig', 2, { message: 'TaskPushNotificationConfig' }),
    f('historyLength', 3, 'int32', present),
    f('returnImmediately', 4, 'bool'),
  ],
  Task: [
    f('id', 1, 'string'),
    f('contextId', 2, 'string'),
    f('status', 3, { message: 'TaskStatus' }),
    f('artifacts', 4, { message: 'Artifact' }, many),
    f('history', 5, { message: 'Message' }, many),
    f('metadata', 6, 'struct'),
  ],
  TaskStatus: [
    f('state', 1, { enum: TASK_STATE }),
    f('message', 2, { message: 'Message' }),
    f('timestamp', 3, 'timestamp'),
  ],
  Part: [
    f('text', 1, 'string', present),
    f('raw', 2, 'bytes', present),
    f('url', 3, 'string', present),
    f('data', 4, 'value', present),
    f('metadata', 5, 'struct'),
    f('filename', 6, 'string'),
    f('mediaType', 7, 'string'),
  ],
  Message: [
    f('messageId', 1, 'string'),
    f('contextId', 2, 'string'),
    f('taskId', 3, 'string'),
    f('role', 4, { enum: ROLE }),
    f('parts', 5, { message: 'Part' }, all),
    f('metadata', 6, 'struct'),
    f('extensions', 7, 'string', many),
    f('referenceTaskIds', 8, 'string', many),
  ],
  Artifact: [
    f('artifactId', 1, 'string'),
    f('name', 2, 'string'),
    f('description', 3, 'string'),
    f('parts', 4, { message: 'Part' }, all),
    f('metadata', 5, 'struct'),
    f('extensions', 6, 'string', many),
  ],
  TaskStatusUpdateEvent: [
    f('taskId', 1, 'string'),
    f('contextId', 2, 'string'),
    f('status', 3, { message: 'TaskStatus' }),
    f('metadata', 4, 'struct'),
  ],
  TaskArtifactUpdateEvent: [
    f('taskId', 1, 'string'),
    f('contextId', 2, 'string'),
    f('artifact', 3, { message: 'Artifact' }),
    f('append', 4, 'bool'),
    f('lastChunk', 5, 'bool'),
    f('metadata', 6, 'struct'),
  ],
  AuthenticationInfo: [f('scheme', 1, 'string'), f('credentials', 2, 'string')],
  AgentInterface: [
    f('url', 1, 'string'),
    f('protocolBinding', 2, 'string'),
    f('tenant', 3, 'string'),
    f('protocolVersion', 4, 'string'),
  ],
  AgentCard: [
    f('name', 1, 'string'),
    f('description', 2, 'string'),
    f('supportedInterfaces', 3, { message: 'AgentInterface' }, all),
    f('provider', 4, { message: 'AgentProvider' }),
    f('version', 5, 'string'),
    f('documentationUrl', 6, 'string', present),
    f('capabilities', 7, { message: 'AgentCapabilities' }),
    f('defaultInputModes', 10, 'string', all),
    f('defaultOutputModes', 11, 'string', all),
    f('skills', 12, { message: 'AgentSkill' }, all),
    f('iconUrl', 14, 'string', present),
  ],
  AgentProvider: [f('url', 1, 'string'), f('organization', 2, 'string')],
  AgentCapabilities: [
    f('streaming', 1, 'bool', present),
    f('pushNotifications', 2, 'bool', present),
    f('extensions', 3, { message: 'AgentExtension' }, many),
    f('extendedAgentCard', 4, 'bool', present),
  ],
  AgentExtension: [
    f('uri', 1, 'string'),
    f('description', 2, 'string'),
    f('required', 3, 'bool'),
    f('params', 4, 'struct'),
  ],
  AgentSkill: [
    f('id', 1, 'string'),
    f('name', 2, 'string'),
    f('description', 3, 'string'),
    f('tags', 4, 'string', all),
    f('examples', 5, 'string', many),
    f('inputModes', 6, 'string', many),
    f('outputModes', 7, 'string', many),
  ],
  TaskPushNotificationConfig: [
    f('tenant', 1, 'string'),
    f('id', 2, 'string'),
    f('taskId', 3, 'string'),
    f('url', 4, 'string'),
    f('token', 5, 'string'),
    f('authentication', 6, { message: 'AuthenticationInfo' }),
  ],
  SendMessageRequest: [
    f('tenant', 1, 'string'),
    f('message', 2, { message: 'Message' }),
    f('configuration', 3, { message: 'SendMessageConfiguration' }),
    f('metadata', 4, 'struct'),
  ],
  GetTaskRequest: [f('tenant', 1, 'string'), f('id', 2, 'string'), f('historyLength', 3, 'int32', present)],
  ListTasksRequest: [
    f('tenant', 1, 'string'),
    f('contextId', 2, 'string'),
    f('status', 3, { enum: TASK_STATE }),
    f('pageSize', 4, 'int32', present),
    f('pageToken', 5, 'string'),
    f('historyLength', 6, 'int32', present),
    f('statusTimestampAfter', 7, 'timestamp'),
    f('includeArtifacts', 8, 'bool', present),
  ],
  ListTasksResponse: [
    f('tasks', 1, { message: 'Task' }, all),
    f('nextPageToken', 2, 'string'),
    f('pageSize', 3, 'int32'),
    f('totalSize', 4, 'int32'),
  ],
  CancelTaskRequest: [f('tenant', 1, 'string'), f('id', 2, 'string'), f('metadata', 3, 'struct')],
  GetTaskPushNotificationConfigRequest: [f('tenant', 1, 'string'), f('taskId', 2, 'string'), f('id', 3, 'string')],
  DeleteTaskPushNotificationConfigRequest: [f('tenant', 1, 'string'), f('taskId', 2, 'string'), f('id', 3, 'string')],
  SubscribeToTaskRequest: [f('tenant', 1, 'string'), f('id', 2, 'string')],
  ListTaskPushNotificationConfigsRequest: [
    f('tenant', 4, 'string'),
    f('taskId', 1, 'string'),
    f('pageSize', 2, 'int32'),
    f('pageToken', 3, 'string'),
  ],
  GetExtendedAgentCardRequest: [f('tenant', 1, 'string')],
  SendMessageResponse: [f('task', 1, { message: 'Task' }), f('message', 2, { message: 'Message' })],
  StreamResponse: [
    f('task', 1, { message: 'Task' }),
    f('message', 2, { message: 'Message' }),
    f('statusUpdate', 3, { message: 'TaskStatusUpdateEvent' }),
    f('artifactUpdate', 4, { message: 'TaskArtifactUpdateEvent' }),
  ],
  ListTaskPushNotificationConfigsResponse: [
    f('configs', 1, { message: 'TaskPushNotificationConfig' }, many),
    f('nextPageToken', 2, 'string'),
  ],
  Empty: [],
  // google.rpc
  Status: [f('code', 1, 'int32'), f('message', 2, 'string'), f('details', 3, { message: 'Any' }, many)],
  Any: [f('typeUrl', 1, 'string'), f('value', 2, 'bytes')],
  ErrorInfo: [f('reason', 1, 'string'), f('domain', 2, 'string'), f('metadata', 3, 'stringMap')],
};

/** Each method of `lf.a2a.v1.A2AService`: what it takes, what it answers, and whether it streams. */
export const A2A_GRPC_METHODS: Readonly<Record<string, { request: string; response: string; stream?: boolean }>> = {
  SendMessage: { request: 'SendMessageRequest', response: 'SendMessageResponse' },
  SendStreamingMessage: { request: 'SendMessageRequest', response: 'StreamResponse', stream: true },
  GetTask: { request: 'GetTaskRequest', response: 'Task' },
  ListTasks: { request: 'ListTasksRequest', response: 'ListTasksResponse' },
  CancelTask: { request: 'CancelTaskRequest', response: 'Task' },
  SubscribeToTask: { request: 'SubscribeToTaskRequest', response: 'StreamResponse', stream: true },
  CreateTaskPushNotificationConfig: { request: 'TaskPushNotificationConfig', response: 'TaskPushNotificationConfig' },
  GetTaskPushNotificationConfig: {
    request: 'GetTaskPushNotificationConfigRequest',
    response: 'TaskPushNotificationConfig',
  },
  ListTaskPushNotificationConfigs: {
    request: 'ListTaskPushNotificationConfigsRequest',
    response: 'ListTaskPushNotificationConfigsResponse',
  },
  DeleteTaskPushNotificationConfig: { request: 'DeleteTaskPushNotificationConfigRequest', response: 'Empty' },
  GetExtendedAgentCard: { request: 'GetExtendedAgentCardRequest', response: 'AgentCard' },
};

/** The service's path prefix: `/lf.a2a.v1.A2AService/<method>`. */
export const A2A_GRPC_SERVICE = 'lf.a2a.v1.A2AService';

// ── Writing ──

class Writer {
  private chunks: Uint8Array[] = [];
  private current: number[] = [];

  varint(value: number | bigint): void {
    let big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    // A negative int32 is written as its 64-bit two's complement, ten bytes.
    if (big < 0n) big += 1n << 64n;
    while (big > 0x7fn) {
      this.current.push(Number((big & 0x7fn) | 0x80n));
      big >>= 7n;
    }
    this.current.push(Number(big));
  }

  tag(number: number, wire: number): void {
    this.varint((number << 3) | wire);
  }

  bytes(value: Uint8Array): void {
    this.varint(value.length);
    this.flush();
    this.chunks.push(value);
  }

  double(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    this.current.push(...new Uint8Array(view.buffer));
  }

  private flush(): void {
    if (this.current.length) {
      this.chunks.push(Uint8Array.from(this.current));
      this.current = [];
    }
  }

  finish(): Uint8Array {
    this.flush();
    const length = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Writes the JSON of a message as its Protocol Buffers bytes. */
export function encodeA2a(type: string, value: unknown): Uint8Array {
  const writer = new Writer();
  writeMessage(writer, type, (value ?? {}) as Record<string, unknown>);
  return writer.finish();
}

function writeMessage(writer: Writer, type: string, value: Record<string, unknown>): void {
  const fields = MESSAGES[type];
  if (!fields) throw new Error(`No A2A message is named ${type}`);
  for (const field of fields) {
    const item = value[field.json];
    if (item === undefined || item === null) continue;
    if (field.repeated) {
      if (!Array.isArray(item)) continue;
      for (const element of item) writeField(writer, field, element, true);
    } else writeField(writer, field, item, field.presence === true);
  }
}

function writeField(writer: Writer, field: Field, item: unknown, always: boolean): void {
  const type = field.type;
  if (type === 'string') {
    const text = String(item);
    if (!always && text === '') return;
    writer.tag(field.number, 2);
    writer.bytes(utf8.encode(text));
  } else if (type === 'bool') {
    if (!always && item !== true) return;
    writer.tag(field.number, 0);
    writer.varint(item === true ? 1 : 0);
  } else if (type === 'int32') {
    const number = Number(item);
    if (!Number.isFinite(number) || (!always && number === 0)) return;
    writer.tag(field.number, 0);
    writer.varint(number);
  } else if (type === 'bytes') {
    const bytes = item instanceof Uint8Array ? item : base64Bytes(String(item));
    if (!always && bytes.length === 0) return;
    writer.tag(field.number, 2);
    writer.bytes(bytes);
  } else if (type === 'struct') {
    if (typeof item !== 'object' || Array.isArray(item)) return;
    writer.tag(field.number, 2);
    writer.bytes(structBytes(item as Record<string, unknown>));
  } else if (type === 'value') {
    writer.tag(field.number, 2);
    writer.bytes(valueBytes(item));
  } else if (type === 'timestamp') {
    const time = Date.parse(String(item));
    if (Number.isNaN(time)) return;
    const inner = new Writer();
    const seconds = Math.floor(time / 1000);
    if (seconds !== 0) {
      inner.tag(1, 0);
      inner.varint(seconds);
    }
    const nanos = (time - seconds * 1000) * 1_000_000;
    if (nanos !== 0) {
      inner.tag(2, 0);
      inner.varint(nanos);
    }
    writer.tag(field.number, 2);
    writer.bytes(inner.finish());
  } else if (type === 'stringMap') {
    for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
      const inner = new Writer();
      inner.tag(1, 2);
      inner.bytes(utf8.encode(key));
      inner.tag(2, 2);
      inner.bytes(utf8.encode(String(entry)));
      writer.tag(field.number, 2);
      writer.bytes(inner.finish());
    }
  } else if ('enum' in type) {
    const index = typeof item === 'number' ? item : type.enum.indexOf(String(item));
    if (index < 0 || (!always && index === 0)) return;
    writer.tag(field.number, 0);
    writer.varint(index);
  } else {
    const inner = new Writer();
    writeMessage(inner, type.message, item as Record<string, unknown>);
    writer.tag(field.number, 2);
    writer.bytes(inner.finish());
  }
}

/** `google.protobuf.Struct`: a map of names to `Value`s. */
function structBytes(value: Record<string, unknown>): Uint8Array {
  const writer = new Writer();
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const entry = new Writer();
    entry.tag(1, 2);
    entry.bytes(utf8.encode(key));
    entry.tag(2, 2);
    entry.bytes(valueBytes(item));
    writer.tag(1, 2);
    writer.bytes(entry.finish());
  }
  return writer.finish();
}

/** `google.protobuf.Value`: null, a number, a string, a boolean, a struct, or a list. */
function valueBytes(value: unknown): Uint8Array {
  const writer = new Writer();
  if (value === null || value === undefined) {
    writer.tag(1, 0);
    writer.varint(0);
  } else if (typeof value === 'number') {
    writer.tag(2, 1);
    writer.double(value);
  } else if (typeof value === 'string') {
    writer.tag(3, 2);
    writer.bytes(utf8.encode(value));
  } else if (typeof value === 'boolean') {
    writer.tag(4, 0);
    writer.varint(value ? 1 : 0);
  } else if (Array.isArray(value)) {
    const list = new Writer();
    for (const item of value) {
      list.tag(1, 2);
      list.bytes(valueBytes(item));
    }
    writer.tag(6, 2);
    writer.bytes(list.finish());
  } else if (typeof value === 'object') {
    writer.tag(5, 2);
    writer.bytes(structBytes(value as Record<string, unknown>));
  } else {
    writer.tag(3, 2);
    writer.bytes(utf8.encode(String(value)));
  }
  return writer.finish();
}

// ── Reading ──

interface RawField {
  number: number;
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
  fixed64?: Uint8Array;
}

/** Every field of a message's bytes, in order, a field's bytes not yet read further. */
function rawFields(bytes: Uint8Array): RawField[] {
  const out: RawField[] = [];
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (offset >= bytes.length) throw new Error('A2A message ended inside a varint');
      const byte = bytes[offset++] as number;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (offset < bytes.length) {
    const key = Number(varint());
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ number, wire, varint: varint() });
    else if (wire === 2) {
      const length = Number(varint());
      if (offset + length > bytes.length) throw new Error('A2A message ended inside a field');
      out.push({ number, wire, bytes: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1) {
      out.push({ number, wire, fixed64: bytes.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 5) offset += 4;
    else throw new Error(`A2A message has a field of wire type ${wire}`);
  }
  return out;
}

/** Reads a message's bytes as its JSON. */
export function decodeA2a(type: string, bytes: Uint8Array): Record<string, unknown> {
  const fields = MESSAGES[type];
  if (!fields) throw new Error(`No A2A message is named ${type}`);
  const byNumber = new Map(fields.map((field) => [field.number, field]));
  const out: Record<string, unknown> = {};
  for (const raw of rawFields(bytes)) {
    const field = byNumber.get(raw.number);
    if (!field) continue;
    const value = readField(field, raw);
    if (value === undefined) continue;
    if (field.type === 'stringMap') out[field.json] = { ...(out[field.json] as object), ...(value as object) };
    else if (field.repeated) {
      const list = (out[field.json] as unknown[] | undefined) ?? [];
      list.push(value);
      out[field.json] = list;
    } else out[field.json] = value;
  }
  for (const field of fields) if (field.required && out[field.json] === undefined) out[field.json] = [];
  return out;
}

function readField(field: Field, raw: RawField): unknown {
  const type = field.type;
  if (type === 'string') return raw.bytes ? fromUtf8.decode(raw.bytes) : undefined;
  if (type === 'bool') return raw.varint !== undefined ? raw.varint !== 0n : undefined;
  if (type === 'int32') return raw.varint !== undefined ? Number(BigInt.asIntN(32, raw.varint)) : undefined;
  if (type === 'bytes') return raw.bytes ? bytesBase64(raw.bytes) : undefined;
  if (type === 'struct') return raw.bytes ? readStruct(raw.bytes) : undefined;
  if (type === 'value') return raw.bytes ? readValue(raw.bytes) : undefined;
  if (type === 'timestamp') {
    if (!raw.bytes) return undefined;
    let seconds = 0n;
    let nanos = 0n;
    for (const inner of rawFields(raw.bytes)) {
      if (inner.number === 1 && inner.varint !== undefined) seconds = BigInt.asIntN(64, inner.varint);
      if (inner.number === 2 && inner.varint !== undefined) nanos = inner.varint;
    }
    return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos) / 1_000_000)).toISOString();
  }
  if (type === 'stringMap') {
    if (!raw.bytes) return undefined;
    let key = '';
    let value = '';
    for (const inner of rawFields(raw.bytes)) {
      if (inner.number === 1 && inner.bytes) key = fromUtf8.decode(inner.bytes);
      if (inner.number === 2 && inner.bytes) value = fromUtf8.decode(inner.bytes);
    }
    return { [key]: value };
  }
  if ('enum' in type) {
    if (raw.varint === undefined) return undefined;
    return type.enum[Number(raw.varint)] ?? Number(raw.varint);
  }
  return raw.bytes ? decodeA2a(type.message, raw.bytes) : undefined;
}

function readStruct(bytes: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of rawFields(bytes)) {
    if (entry.number !== 1 || !entry.bytes) continue;
    let key = '';
    let value: unknown = null;
    for (const inner of rawFields(entry.bytes)) {
      if (inner.number === 1 && inner.bytes) key = fromUtf8.decode(inner.bytes);
      if (inner.number === 2 && inner.bytes) value = readValue(inner.bytes);
    }
    out[key] = value;
  }
  return out;
}

function readValue(bytes: Uint8Array): unknown {
  let value: unknown = null;
  for (const raw of rawFields(bytes)) {
    if (raw.number === 1) value = null;
    else if (raw.number === 2 && raw.fixed64) {
      value = new DataView(raw.fixed64.buffer, raw.fixed64.byteOffset, 8).getFloat64(0, true);
    } else if (raw.number === 3 && raw.bytes) value = fromUtf8.decode(raw.bytes);
    else if (raw.number === 4 && raw.varint !== undefined) value = raw.varint !== 0n;
    else if (raw.number === 5 && raw.bytes) value = readStruct(raw.bytes);
    else if (raw.number === 6 && raw.bytes) {
      value = rawFields(raw.bytes)
        .filter((item) => item.number === 1 && item.bytes)
        .map((item) => readValue(item.bytes as Uint8Array));
    }
  }
  return value;
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A `google.rpc.Status` with A2A's `ErrorInfo`, as `grpc-status-details-bin` carries it. */
export function encodeA2aStatus(code: number, message: string, reason: string): Uint8Array {
  return encodeA2a('Status', {
    code,
    message,
    details: [
      {
        typeUrl: 'type.googleapis.com/google.rpc.ErrorInfo',
        value: encodeA2a('ErrorInfo', { reason, domain: 'a2a-protocol.org' }),
      },
    ],
  });
}

/** The `ErrorInfo` reason of a `google.rpc.Status`, when it has one. */
export function a2aStatusReason(bytes: Uint8Array): { message?: string; reason?: string } {
  const status = decodeA2a('Status', bytes) as {
    message?: string;
    details?: Array<{ typeUrl?: string; value?: string }>;
  };
  const info = status.details?.find((detail) => detail.typeUrl?.endsWith('google.rpc.ErrorInfo'));
  const reason = info?.value
    ? (decodeA2a('ErrorInfo', base64Bytes(info.value)).reason as string | undefined)
    : undefined;
  return { ...(status.message ? { message: status.message } : {}), ...(reason ? { reason } : {}) };
}
