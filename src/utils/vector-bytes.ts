/**
 * Vectors as bytes, for the caches that keep them outside the process. Kept apart from the caches so
 * a database adapter carries only this.
 */

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * A vector as packed little-endian float32: four bytes a dimension, against about twenty as JSON.
 * Providers return float32 precision, so nothing they sent is lost.
 */
export function packVector(vector: readonly number[]): Uint8Array {
  if (littleEndian) return new Uint8Array(Float32Array.from(vector).buffer);
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of vector.entries()) view.setFloat32(index * 4, value, true);
  return bytes;
}

/** A vector from the bytes `packVector()` wrote. */
export function unpackVector(bytes: Uint8Array): number[] {
  if (bytes.byteLength % 4 !== 0) throw new RangeError('a packed vector is a whole number of float32 values');
  if (littleEndian) return Array.from(new Float32Array(bytes.slice().buffer));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 4 }, (_, index) => view.getFloat32(index * 4, true));
}
