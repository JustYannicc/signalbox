// @effect-diagnostics nodeBuiltinImport:off - Node's public stream conversion keeps both APIs on one stream.
import * as NodeStream from "node:stream";

export function toBunStdinReadable(stream: NodeStream.Readable): ReadableStream<Uint8Array> {
  // Borrowed process.stdin must stay untouched until Bun asks for data.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          reader ??= (NodeStream.Readable.toWeb(stream) as ReadableStream<Uint8Array>).getReader();
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
            reader = undefined;
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (reader === undefined) return;
        const activeReader = reader;
        reader = undefined;
        await activeReader.cancel(reason);
        activeReader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
}

export function toBunChildOutputReadable(stream: NodeStream.Readable): ReadableStream<Uint8Array> {
  // Attach before ChildProcess resumes these pipes when it observes exit.
  return NodeStream.Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export function toBunWritable(stream: NodeStream.Writable): WritableStream<Uint8Array> {
  return NodeStream.Writable.toWeb(stream) as WritableStream<Uint8Array>;
}
