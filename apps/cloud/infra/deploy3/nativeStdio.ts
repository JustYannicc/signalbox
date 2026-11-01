export const NATIVE_STDIO_CHANNELS = ["native-stdin", "native-stdout", "native-stderr"] as const;

export type NativeStdioChannel = (typeof NATIVE_STDIO_CHANNELS)[number];

const CHUNK_BYTES = 32_768; // Matches BlobJournal's part size.

type Stream = {
  observedBytes: number;
  acceptedBytes: number;
  chunkCount: number;
  complete: boolean;
  incompleteReason: string | null;
};

const stream = (): Stream => ({
  observedBytes: 0,
  acceptedBytes: 0,
  chunkCount: 0,
  complete: true,
  incompleteReason: null,
});

function publish(
  channel: NativeStdioChannel,
  value: Stream,
  bytes: Uint8Array,
  enqueue: (channel: NativeStdioChannel, bytes: Uint8Array) => boolean,
) {
  if (!enqueue(channel, bytes)) {
    value.complete = false;
    value.incompleteReason = "capture-sink-rejected";
    return false;
  }
  value.acceptedBytes += bytes.byteLength;
  value.chunkCount += 1;
  return true;
}

function snapshot(channel: NativeStdioChannel, value: Stream) {
  return {
    observation: channel === "native-stdin" ? ("consumed" as const) : ("accepted" as const),
    observedBytes: value.observedBytes,
    acceptedBytes: value.acceptedBytes,
    chunkCount: value.chunkCount,
    complete: value.complete,
    incompleteReason: value.incompleteReason,
  };
}

/** Copies observed stdio into bounded chunks without waiting for storage writes. */
export function createNativeStdioCapture() {
  const streams: Record<NativeStdioChannel, Stream> = {
    "native-stdin": stream(),
    "native-stdout": stream(),
    "native-stderr": stream(),
  };

  return {
    write(
      channel: NativeStdioChannel,
      bytes: Uint8Array,
      enqueue: (channel: NativeStdioChannel, bytes: Uint8Array) => boolean,
    ) {
      const value = streams[channel];
      value.observedBytes += bytes.byteLength;
      if (!value.complete) return;

      let offset = 0;
      while (offset < bytes.byteLength) {
        const count = Math.min(CHUNK_BYTES, bytes.byteLength - offset);
        const chunk = bytes.slice(offset, offset + count);
        offset += count;
        if (!publish(channel, value, chunk, enqueue)) return;
      }
    },
    drain() {
      return {
        schema: "sb1070/native-stdio-streams/v1" as const,
        streams: {
          "native-stdin": snapshot("native-stdin", streams["native-stdin"]),
          "native-stdout": snapshot("native-stdout", streams["native-stdout"]),
          "native-stderr": snapshot("native-stderr", streams["native-stderr"]),
        },
      };
    },
  };
}
