import type { TelephonyGatherConfig, TelephonyResponseRequest, TelephonyStreamConfig } from '../types/telephony.js';

export function createVoiceTwiML(request: TelephonyResponseRequest): string {
  const body: string[] = [];

  if (request.gather) {
    body.push(createGather(request.gather));
  } else {
    for (const text of values(request.say)) body.push(tag('Say', {}, escapeXml(text)));
  }

  for (const url of values(request.playUrl)) body.push(tag('Play', {}, escapeXml(url)));

  if (request.pauseSeconds !== undefined) {
    body.push(emptyTag('Pause', { length: String(request.pauseSeconds) }));
  }

  if (request.stream) body.push(createStream(request.stream));

  if (request.redirectUrl) {
    body.push(
      tag(
        'Redirect',
        {
          ...(request.redirectMethod ? { method: request.redirectMethod } : {}),
        },
        escapeXml(request.redirectUrl),
      ),
    );
  }

  if (request.hangup) body.push(emptyTag('Hangup'));

  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body.join('')}</Response>`;
}

function createGather(gather: TelephonyGatherConfig): string {
  const prompts = (gather.prompts || []).map((prompt) => tag('Say', {}, escapeXml(prompt))).join('');
  return tag(
    'Gather',
    {
      ...(gather.input?.length ? { input: gather.input.join(' ') } : {}),
      ...(gather.actionUrl ? { action: gather.actionUrl } : {}),
      ...(gather.method ? { method: gather.method } : {}),
      ...(gather.timeoutSeconds !== undefined ? { timeout: String(gather.timeoutSeconds) } : {}),
      ...(gather.speechTimeout !== undefined ? { speechTimeout: String(gather.speechTimeout) } : {}),
      ...(gather.language ? { language: gather.language } : {}),
      ...(gather.finishOnKey ? { finishOnKey: gather.finishOnKey } : {}),
      ...(gather.numDigits !== undefined ? { numDigits: String(gather.numDigits) } : {}),
    },
    prompts,
  );
}

function createStream(stream: TelephonyStreamConfig): string {
  const attributes = {
    url: stream.url,
    ...(stream.name ? { name: stream.name } : {}),
    ...(stream.track && stream.mode !== 'bidirectional' ? { track: toTwilioTrack(stream.track) } : {}),
    ...(stream.statusCallbackUrl ? { statusCallback: stream.statusCallbackUrl } : {}),
    ...(stream.statusCallbackMethod ? { statusCallbackMethod: stream.statusCallbackMethod } : {}),
  };
  const parameters = Object.entries(stream.parameters || {})
    .map(([name, value]) => emptyTag('Parameter', { name, value: String(value) }))
    .join('');
  const streamXml = tag('Stream', attributes, parameters);

  if (stream.mode === 'bidirectional') return tag('Connect', {}, streamXml);
  return tag('Start', {}, streamXml);
}

function tag(name: string, attributes: Record<string, string> = {}, body = ''): string {
  return `<${name}${attrs(attributes)}>${body}</${name}>`;
}

function emptyTag(name: string, attributes: Record<string, string> = {}): string {
  return `<${name}${attrs(attributes)}/>`;
}

function attrs(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}

function values(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function toTwilioTrack(track: TelephonyStreamConfig['track']): string | undefined {
  if (track === 'inbound') return 'inbound_track';
  if (track === 'outbound') return 'outbound_track';
  if (track === 'both') return 'both_tracks';
  return undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
