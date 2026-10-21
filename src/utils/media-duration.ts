/**
 * How long a piece of audio or video is, read from the file's own headers, without decoding it and
 * without a dependency: WAV, MP4 and MOV, WebM and Matroska, MP3, Ogg (Vorbis and Opus), and FLAC.
 * Portable: plain bytes in, a number out.
 */

/** What the headers say: the length, the container's type, and whether it holds a picture. */
export interface MediaDuration {
  /** Its length in milliseconds. */
  durationMs: number;
  /** Its container's MIME type, such as `video/mp4` or `audio/ogg`. */
  mimeType: string;
  /** `video` when it holds a picture track, `audio` when only sound. */
  kind: 'audio' | 'video';
}

/**
 * The length of audio or video from its headers, or `undefined` when the bytes are none of the
 * containers read, or say no length: a stream still being written, or a file cut short before the
 * part that says it.
 */
export function readMediaDuration(bytes: Uint8Array): MediaDuration | undefined {
  try {
    return wav(bytes) ?? isoMedia(bytes) ?? matroska(bytes) ?? flac(bytes) ?? ogg(bytes) ?? mp3(bytes);
  } catch {
    // A header that lies about its own sizes is read as no length, never as an error.
    return undefined;
  }
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = '';
  for (let index = at; index < at + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] as number);
  }
  return text;
}

const milliseconds = (units: number, perSecond: number) =>
  perSecond > 0 && Number.isFinite(units) && units > 0 ? Math.round((units / perSecond) * 1000) : undefined;

// ── WAV ──

function wav(bytes: Uint8Array): MediaDuration | undefined {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return undefined;
  const data = view(bytes);
  let byteRate: number | undefined;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(bytes, at, 4);
    const size = data.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 16 <= bytes.length) byteRate = data.getUint32(at + 16, true);
    if (id === 'data') {
      const durationMs = byteRate ? milliseconds(size, byteRate) : undefined;
      return durationMs === undefined ? undefined : { durationMs, mimeType: 'audio/wav', kind: 'audio' };
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

// ── MP4 and MOV: ISO base media ──

interface Box {
  type: string;
  /** Where its payload starts. */
  start: number;
  /** Where it ends. */
  end: number;
}

/** The boxes between two offsets, in order. */
function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const data = view(bytes);
  const found: Box[] = [];
  for (let at = from; at + 8 <= to; ) {
    let size = data.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = Number(data.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header) break;
    found.push({ type, start: at + header, end: Math.min(at + size, to) });
    at += size;
  }
  return found;
}

const child = (bytes: Uint8Array, box: Box | undefined, type: string) =>
  box ? boxes(bytes, box.start, box.end).find((item) => item.type === type) : undefined;

function isoMedia(bytes: Uint8Array): MediaDuration | undefined {
  const top = boxes(bytes, 0, bytes.length);
  const first = top[0]?.type;
  if (!first || !['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(first)) return undefined;
  const moov = top.find((box) => box.type === 'moov');
  const mvhd = child(bytes, moov, 'mvhd');
  if (!moov || !mvhd) return undefined;
  const data = view(bytes);
  const version = bytes[mvhd.start];
  const timescale = data.getUint32(mvhd.start + (version === 1 ? 20 : 12));
  let units = version === 1 ? Number(data.getBigUint64(mvhd.start + 24)) : data.getUint32(mvhd.start + 16);
  if (units === 0 || units === 0xffffffff) {
    // A fragmented file says its length in the movie extends header, when it says it at all.
    const mehd = child(bytes, child(bytes, moov, 'mvex'), 'mehd');
    if (mehd)
      units = bytes[mehd.start] === 1 ? Number(data.getBigUint64(mehd.start + 4)) : data.getUint32(mehd.start + 4);
  }
  let durationMs = milliseconds(units, timescale);
  // Otherwise its fragments say it: where the last one starts, and how long its samples last.
  durationMs ??= fragmentsDuration(bytes, top, moov);
  if (durationMs === undefined) return undefined;
  const handlers = boxes(bytes, moov.start, moov.end)
    .filter((box) => box.type === 'trak')
    .map((trak) => child(bytes, child(bytes, trak, 'mdia'), 'hdlr'))
    .map((hdlr) => (hdlr ? ascii(bytes, hdlr.start + 8, 4) : ''));
  const video = handlers.includes('vide');
  const brand = top[0]?.type === 'ftyp' ? ascii(bytes, (top[0] as Box).start, 4) : '';
  const mimeType = brand === 'qt  ' ? 'video/quicktime' : video ? 'video/mp4' : 'audio/mp4';
  return { durationMs, mimeType, kind: video ? 'video' : 'audio' };
}

/**
 * A fragmented file's length, in its first track's timescale: the decode time of its last fragment
 * (`tfdt`) and the durations of that fragment's samples (`trun`, or the defaults of `tfhd` and `trex`).
 */
function fragmentsDuration(bytes: Uint8Array, top: Box[], moov: Box): number | undefined {
  const data = view(bytes);
  const trak = boxes(bytes, moov.start, moov.end).find((box) => box.type === 'trak');
  const tkhd = child(bytes, trak, 'tkhd');
  const mdhd = child(bytes, child(bytes, trak, 'mdia'), 'mdhd');
  if (!tkhd || !mdhd) return undefined;
  const trackId = data.getUint32(tkhd.start + (bytes[tkhd.start] === 1 ? 20 : 12));
  const timescale = data.getUint32(mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12));
  // trex: track_ID 4, default_sample_description_index 8, default_sample_duration 12.
  const trex = boxes(bytes, child(bytes, moov, 'mvex')?.start ?? 0, child(bytes, moov, 'mvex')?.end ?? 0).find(
    (box) => box.type === 'trex' && data.getUint32(box.start + 4) === trackId,
  );
  const trexDuration = trex ? data.getUint32(trex.start + 12) : 0;
  let end = 0;
  let elapsed = 0;
  for (const moof of top.filter((box) => box.type === 'moof')) {
    for (const traf of boxes(bytes, moof.start, moof.end).filter((box) => box.type === 'traf')) {
      const tfhd = child(bytes, traf, 'tfhd');
      if (!tfhd || data.getUint32(tfhd.start + 4) !== trackId) continue;
      // tfhd: its flags say which optional fields follow the track id, in this order.
      const flags = data.getUint32(tfhd.start) & 0xffffff;
      let at = tfhd.start + 8;
      if (flags & 0x01) at += 8;
      if (flags & 0x02) at += 4;
      const defaultDuration = flags & 0x08 ? data.getUint32(at) : trexDuration;
      const tfdt = child(bytes, traf, 'tfdt');
      const start = tfdt
        ? bytes[tfdt.start] === 1
          ? Number(data.getBigUint64(tfdt.start + 4))
          : data.getUint32(tfdt.start + 4)
        : elapsed;
      let length = 0;
      for (const trun of boxes(bytes, traf.start, traf.end).filter((box) => box.type === 'trun')) {
        const runFlags = data.getUint32(trun.start) & 0xffffff;
        const count = data.getUint32(trun.start + 4);
        let cursor = trun.start + 8 + (runFlags & 0x01 ? 4 : 0) + (runFlags & 0x04 ? 4 : 0);
        // Each sample's fields, as its flags say: duration, size, flags, composition offset.
        const fields = [0x100, 0x200, 0x400, 0x800].filter((flag) => runFlags & flag).length;
        for (let sample = 0; sample < count; sample += 1) {
          length += runFlags & 0x100 ? data.getUint32(cursor) : defaultDuration;
          cursor += fields * 4;
        }
      }
      elapsed = start + length;
      end = Math.max(end, elapsed);
    }
  }
  return milliseconds(end, timescale);
}

// ── WebM and Matroska: EBML ──

/** An EBML variable-length integer at `at`: its value, its length, and whether it is all ones (unknown). */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = bytes[at] as number;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || at + length > bytes.length) throw new Error('not an EBML integer');
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = (first & (0xff >> length)) === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[at + index] as number;
    value = value * 256 + byte;
    ones &&= byte === 0xff;
  }
  return { value, length, unknown: !keepMarker && ones };
}

interface Element {
  id: number;
  start: number;
  end: number;
}

/** The elements between two offsets; one of unknown size runs to the end of its parent. */
function elements(bytes: Uint8Array, from: number, to: number): Element[] {
  const found: Element[] = [];
  for (let at = from; at < to; ) {
    const id = vint(bytes, at, true);
    const size = vint(bytes, at + id.length, false);
    const start = at + id.length + size.length;
    const end = size.unknown ? to : Math.min(start + size.value, to);
    found.push({ id: id.value, start, end });
    if (size.unknown) break;
    at = end;
  }
  return found;
}

const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CLUSTER = 0x1f43b675;

function uint(bytes: Uint8Array, element: Element): number {
  let value = 0;
  for (let at = element.start; at < element.end; at += 1) value = value * 256 + (bytes[at] as number);
  return value;
}

function matroska(bytes: Uint8Array): MediaDuration | undefined {
  if (bytes.length < 4 || view(bytes).getUint32(0) !== EBML) return undefined;
  const top = elements(bytes, 0, bytes.length);
  const header = top.find((element) => element.id === EBML);
  const docType = header
    ? elements(bytes, header.start, header.end).find((element) => element.id === DOC_TYPE)
    : undefined;
  const type = docType ? ascii(bytes, docType.start, docType.end - docType.start).replace(/\0+$/, '') : '';
  const segment = top.find((element) => element.id === SEGMENT);
  if (!segment) return undefined;
  let scale = 1_000_000;
  let units: number | undefined;
  let video = false;
  // The segment's head says its length and its tracks; its clusters, the media itself, are skipped.
  for (const element of elements(bytes, segment.start, segment.end)) {
    if (element.id === CLUSTER) break;
    if (element.id === INFO) {
      for (const field of elements(bytes, element.start, element.end)) {
        if (field.id === TIMECODE_SCALE) scale = uint(bytes, field);
        if (field.id === DURATION) {
          const length = field.end - field.start;
          units =
            length === 4
              ? view(bytes).getFloat32(field.start)
              : length === 8
                ? view(bytes).getFloat64(field.start)
                : undefined;
        }
      }
    }
    if (element.id === TRACKS) {
      for (const entry of elements(bytes, element.start, element.end)) {
        if (entry.id !== TRACK_ENTRY) continue;
        const kind = elements(bytes, entry.start, entry.end).find((field) => field.id === TRACK_TYPE);
        if (kind && uint(bytes, kind) === 1) video = true;
      }
    }
  }
  const durationMs = units === undefined ? undefined : milliseconds(units * scale, 1_000_000_000);
  if (durationMs === undefined) return undefined;
  const container = type === 'webm' ? 'webm' : 'x-matroska';
  return { durationMs, mimeType: `${video ? 'video' : 'audio'}/${container}`, kind: video ? 'video' : 'audio' };
}

// ── FLAC ──

function flac(bytes: Uint8Array): MediaDuration | undefined {
  if (ascii(bytes, 0, 4) !== 'fLaC' || bytes.length < 26 || ((bytes[4] as number) & 0x7f) !== 0) return undefined;
  // STREAMINFO, from byte 8: after the block sizes and frame sizes, 20 bits of sample rate, 3 of
  // channels, 5 of sample size, and 36 of samples.
  const rate = ((bytes[18] as number) << 12) | ((bytes[19] as number) << 4) | ((bytes[20] as number) >> 4);
  const samples =
    ((bytes[21] as number) & 0x0f) * 2 ** 32 +
    (((bytes[22] as number) << 24) >>> 0) +
    ((bytes[23] as number) << 16) +
    ((bytes[24] as number) << 8) +
    (bytes[25] as number);
  const durationMs = milliseconds(samples, rate);
  return durationMs === undefined ? undefined : { durationMs, mimeType: 'audio/flac', kind: 'audio' };
}

// ── Ogg: Vorbis and Opus ──

function ogg(bytes: Uint8Array): MediaDuration | undefined {
  if (ascii(bytes, 0, 4) !== 'OggS' || bytes.length < 28) return undefined;
  const data = view(bytes);
  const serial = data.getUint32(14, true);
  const segments = bytes[26] as number;
  const payload = 27 + segments;
  let rate: number;
  let preSkip = 0;
  if (bytes[payload] === 0x01 && ascii(bytes, payload + 1, 6) === 'vorbis') {
    rate = data.getUint32(payload + 12, true);
  } else if (ascii(bytes, payload, 8) === 'OpusHead') {
    // Opus counts granules at 48 kHz whatever it was recorded at, and skips the first ones.
    rate = 48_000;
    preSkip = data.getUint16(payload + 10, true);
  } else {
    return undefined;
  }
  // The last page of the stream says how many samples came before its end.
  for (let at = bytes.length - 27; at >= 0; at -= 1) {
    if (bytes[at] !== 0x4f || ascii(bytes, at, 4) !== 'OggS' || data.getUint32(at + 14, true) !== serial) continue;
    const granule = data.getBigInt64(at + 6, true);
    if (granule < 0n) continue;
    const durationMs = milliseconds(Number(granule) - preSkip, rate);
    return durationMs === undefined ? undefined : { durationMs, mimeType: 'audio/ogg', kind: 'audio' };
  }
  return undefined;
}

// ── MP3 ──

const MPEG1_LAYER3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame {
  /** 3 for MPEG-1, 2 for MPEG-2, 0 for MPEG-2.5. */
  version: number;
  bitrate: number;
  rate: number;
  samples: number;
  length: number;
  mono: boolean;
}

/** An MPEG audio layer III frame header at `at`, or undefined. */
function frame(bytes: Uint8Array, at: number): Frame | undefined {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || ((bytes[at + 1] as number) & 0xe0) !== 0xe0) return undefined;
  const version = ((bytes[at + 1] as number) >> 3) & 3;
  const layer = ((bytes[at + 1] as number) >> 1) & 3;
  if (version === 1 || layer !== 1) return undefined;
  const bitrate = (version === 3 ? MPEG1_LAYER3 : MPEG2_LAYER3)[(bytes[at + 2] as number) >> 4];
  const rate = RATES[version]?.[((bytes[at + 2] as number) >> 2) & 3];
  if (!bitrate || !rate) return undefined;
  const padding = ((bytes[at + 2] as number) >> 1) & 1;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate * 1000) / rate) + padding;
  return { version, bitrate, rate, samples, length, mono: (bytes[at + 3] as number) >> 6 === 3 };
}

function mp3(bytes: Uint8Array): MediaDuration | undefined {
  let at = 0;
  const tagged = ascii(bytes, 0, 3) === 'ID3' && bytes.length >= 10;
  if (tagged) {
    const size =
      (((bytes[6] as number) & 0x7f) << 21) |
      (((bytes[7] as number) & 0x7f) << 14) |
      (((bytes[8] as number) & 0x7f) << 7) |
      ((bytes[9] as number) & 0x7f);
    at = 10 + size + ((bytes[5] as number) & 0x10 ? 10 : 0);
  }
  // Past the tag, the first frame; without a tag, two frames back to back, so other bytes are not read as one.
  const limit = Math.min(bytes.length, at + 64 * 1024);
  let first: Frame | undefined;
  for (; at < limit; at += 1) {
    first = frame(bytes, at);
    if (first && (tagged || frame(bytes, at + first.length))) break;
    first = undefined;
  }
  if (!first) return undefined;
  const data = view(bytes);
  // A variable-bitrate file counts its frames in a Xing, Info, or VBRI header inside its first frame.
  const side = first.version === 3 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  const xing = at + 4 + side;
  let frames: number | undefined;
  const tag = ascii(bytes, xing, 4);
  if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= bytes.length && data.getUint32(xing + 4) & 1) {
    frames = data.getUint32(xing + 8);
  } else if (ascii(bytes, at + 36, 4) === 'VBRI' && at + 54 <= bytes.length) {
    frames = data.getUint32(at + 36 + 14);
  }
  let durationMs: number | undefined;
  if (frames) durationMs = milliseconds(frames * first.samples, first.rate);
  else {
    // A constant bitrate: the audio's bytes at that rate, past any ID3v1 tag at the end.
    const end = ascii(bytes, bytes.length - 128, 3) === 'TAG' ? bytes.length - 128 : bytes.length;
    durationMs = milliseconds((end - at) * 8, first.bitrate * 1000);
  }
  return durationMs === undefined ? undefined : { durationMs, mimeType: 'audio/mpeg', kind: 'audio' };
}
