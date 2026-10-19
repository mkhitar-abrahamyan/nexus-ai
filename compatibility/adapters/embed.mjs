/** A deterministic embedding of 256 hashed word buckets, so every record is made on the same vectors. */
export const embed = async (texts) =>
  texts.map((text) => {
    const vector = new Array(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let hash = 0x811c9dc5;
      for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
      vector[hash % 256] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  });
