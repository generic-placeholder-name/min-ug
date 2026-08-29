export const CANONICAL_URL_BYTE_ALPHABET =
  "!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

const admittedBytes = new Set(Array.from(CANONICAL_URL_BYTE_ALPHABET, character =>
  character.charCodeAt(0)
));

/** True when every code unit is one byte admitted by the neural codec vocabulary. */
export function isCanonicalUrlByteSpelling (value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!admittedBytes.has(value.charCodeAt(index))) return false;
  }
  return true;
}
