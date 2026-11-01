const PREFIX_BYTES = 16_384;
const channels = ["native-stdin", "native-stdout", "native-stderr"] as const;
export type NativeStdioChannel = (typeof channels)[number];

const stream = () => ({
  bytes: new Uint8Array(PREFIX_BYTES),
  length: 0,
  published: 0,
  observed: 0,
});
const snapshot = (channel: NativeStdioChannel, prefix: ReturnType<typeof stream>) => ({
  observation: channel === "native-stdin" ? ("consumed" as const) : ("accepted" as const),
  observedBytes: prefix.observed,
  retainedBytes: prefix.length,
  publishedBytes: prefix.published,
  truncated: prefix.observed > PREFIX_BYTES,
});

/** Retains consumed stdin and accepted output prefixes independently of JSONL framing. */
export function createNativeStdioPrefix() {
  const streams = {
    "native-stdin": stream(),
    "native-stdout": stream(),
    "native-stderr": stream(),
  };
  return {
    write(channel: NativeStdioChannel, bytes: Uint8Array) {
      const prefix = streams[channel];
      prefix.observed += bytes.byteLength;
      const count = Math.min(bytes.byteLength, prefix.bytes.byteLength - prefix.length);
      prefix.bytes.set(bytes.subarray(0, count), prefix.length);
      prefix.length += count;
    },
    drain(publish: (channel: NativeStdioChannel, bytes: Uint8Array) => void) {
      for (const channel of channels) {
        const prefix = streams[channel];
        if (prefix.length > prefix.published) {
          publish(channel, prefix.bytes.slice(prefix.published, prefix.length));
          prefix.published = prefix.length;
        }
      }
      return {
        prefixLimitBytes: PREFIX_BYTES,
        streams: {
          "native-stdin": snapshot("native-stdin", streams["native-stdin"]),
          "native-stdout": snapshot("native-stdout", streams["native-stdout"]),
          "native-stderr": snapshot("native-stderr", streams["native-stderr"]),
        },
      };
    },
  };
}
