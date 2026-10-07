/**
 * SHA-256 in plain JavaScript, with the runtime's native digest where it offers one synchronously.
 * Kept apart from the id helpers, which every provider imports, so only what hashes pays for it.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const encoder = new TextEncoder();

/**
 * SHA-256 that can be fed in pieces, as `createHash('sha256')` is, with the same digest. Strings are
 * hashed as UTF-8. Synchronous, unlike Web Crypto's `digest()`, so a cache key can be computed where
 * it is needed.
 */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private filled = 0;
  private total = 0;

  /** Adds data: a string, as UTF-8, or bytes. */
  update(data: string | Uint8Array): this {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    this.total += bytes.length;
    let offset = 0;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      offset = take;
      if (this.filled < 64) return this;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; offset + 64 <= bytes.length; offset += 64) this.compress(bytes, offset);
    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset), 0);
      this.filled = bytes.length - offset;
    }
    return this;
  }

  /** The digest as lowercase hex. The hash takes no more data afterwards. */
  digest(): string {
    const bits = this.total * 8;
    const padding = new Uint8Array(this.filled < 56 ? 64 - this.filled : 128 - this.filled);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padding.length - 4, bits >>> 0);
    const total = this.total;
    this.update(padding);
    this.total = total;
    let hex = '';
    for (const word of this.state) hex += word.toString(16).padStart(8, '0');
    return hex;
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      w[index] =
        ((bytes[at] as number) << 24) |
        ((bytes[at + 1] as number) << 16) |
        ((bytes[at + 2] as number) << 8) |
        (bytes[at + 3] as number);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) | 0;
    }
    const h = this.state;
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let k = h[7] as number;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const t1 = (k + s1 + choose + (K[index] as number) + (w[index] as number)) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + k;
  }
}

type NativeHash = (algorithm: 'sha256') => { update(data: string | Uint8Array): { digest(encoding: 'hex'): string } };

/**
 * The runtime's own SHA-256 where it offers one synchronously: Node.js 22 and Bun, through
 * `process.getBuiltinModule()`. Found without an import, so other runtimes never load Node code.
 */
const nativeHash: NativeHash | undefined = (() => {
  try {
    const host = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    return (host?.getBuiltinModule?.('crypto') as { createHash?: NativeHash } | undefined)?.createHash;
  } catch {
    return undefined;
  }
})();

/**
 * The SHA-256 digest of a string, as UTF-8, or of bytes, as lowercase hex. Native where the runtime
 * has it, which is ten times faster on large inputs, and the same digest everywhere else.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return nativeHash ? nativeHash('sha256').update(data).digest('hex') : new Sha256().update(data).digest();
}
