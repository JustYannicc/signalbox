/**
 * Two FNV-1a passes with different bases over `text`, as 16 hex characters.
 * Not cryptographic: for short, stable ids that fit a backend's limits. The
 * workflow runtime carries its own copy, since it ships as source text.
 */
export const hash64 = (text: string) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
};
