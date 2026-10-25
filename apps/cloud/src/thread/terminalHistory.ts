const MAX_HISTORY_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const terminalHistoryTail = (text: string): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= MAX_HISTORY_BYTES) return text;
  let start = bytes.byteLength - MAX_HISTORY_BYTES;
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};
