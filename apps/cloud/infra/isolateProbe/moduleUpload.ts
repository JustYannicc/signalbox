import {
  decodeModuleTransport,
  DEFAULT_MODULE_TRANSPORT_LIMITS,
  openModuleTransport,
} from "./moduleTransport.ts";

const MAX_UPLOAD_BYTES =
  4 +
  DEFAULT_MODULE_TRANSPORT_LIMITS.maxMetadataBytes +
  DEFAULT_MODULE_TRANSPORT_LIMITS.maxBodyBytes;

export class ModuleUploadStore {
  private active = false;
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS probe_module_upload (
      sequence INTEGER PRIMARY KEY, data BLOB NOT NULL
    )`);
    // Uploads live only for one request. A restarted object can discard interrupted staging.
    sql.exec("DELETE FROM probe_module_upload");
  }

  async stage(source: ReadableStream<Uint8Array>) {
    // Bound aggregate staging as well as each frame, without blocking legacy concurrency probes.
    if (this.active) throw new Error("Another framed upload is active for this session");
    const reader = source.getReader();
    this.active = true;
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true;
      try {
        this.sql.exec("DELETE FROM probe_module_upload");
      } finally {
        this.active = false;
      }
    };
    let sequence = 0;
    let bytes = 0;
    const buffer = new Uint8Array(64 * 1024);
    let buffered = 0;
    const flush = () => {
      if (buffered === 0) return;
      this.sql.exec(
        "INSERT INTO probe_module_upload(sequence, data) VALUES (?, ?)",
        sequence++,
        buffer.slice(0, buffered).buffer,
      );
      buffered = 0;
    };
    const stored = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const next = await reader.read();
          if (next.done) {
            flush();
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array)) throw new Error("Invalid transport chunk");
          if (next.value.byteLength > MAX_UPLOAD_BYTES - bytes)
            throw new Error("Upload staging budget exceeded");
          bytes += next.value.byteLength;
          for (let offset = 0; offset < next.value.byteLength;) {
            const count = Math.min(buffer.byteLength - buffered, next.value.byteLength - offset);
            buffer.set(next.value.subarray(offset, offset + count), buffered);
            offset += count;
            buffered += count;
            if (buffered === buffer.byteLength) flush();
          }
          controller.enqueue(next.value);
        },
      },
      { highWaterMark: 0 },
    );
    try {
      const transport = await openModuleTransport(stored);
      // Every byte is checked before any worker or facet can execute, including on cache hits.
      await transport.discard();
      return {
        input: transport.input,
        hasPayload: transport.payloadRange !== undefined,
        // Warm WorkerLoader hits skip getCode; read the body without rebuilding the code map.
        readPayload: () => {
          if (released) throw new Error("Staged module upload has been released");
          const range = transport.payloadRange;
          if (!range) return undefined;
          const result = new Uint8Array(range.byteLength);
          let written = 0;
          let offset = range.offset;
          while (written < result.byteLength) {
            const { data } = this.sql
              .exec(
                "SELECT data FROM probe_module_upload WHERE sequence = ?",
                Math.floor(offset / buffer.byteLength),
              )
              .one();
            if (!(data instanceof ArrayBuffer)) throw new Error("Invalid staged payload chunk");
            const start = offset % buffer.byteLength;
            const count = Math.min(data.byteLength - start, result.byteLength - written);
            if (count <= 0) throw new Error("Truncated staged payload");
            result.set(new Uint8Array(data, start, count), written);
            written += count;
            offset += count;
          }
          return result;
        },
        readModules: async () => {
          if (released) throw new Error("Staged module upload has been released");
          let index = 0;
          const replay = new ReadableStream<Uint8Array>(
            {
              pull: (controller) => {
                if (released) throw new Error("Staged module upload has been released");
                if (index === sequence) {
                  controller.close();
                  return;
                }
                const { data } = this.sql
                  .exec("SELECT data FROM probe_module_upload WHERE sequence = ?", index++)
                  .one();
                if (!(data instanceof ArrayBuffer)) throw new Error("Invalid staged module chunk");
                controller.enqueue(new Uint8Array(data));
              },
            },
            { highWaterMark: 0 },
          );
          // Worker entrypoints and durable facets may invoke getCode separately for one stub.
          // Replay from SQL each time; never retain a full map in the loader callback's closure.
          return (await decodeModuleTransport(replay)).modules;
        },
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
    } finally {
      // Releasing permits the HTTP boundary to drain rejected input without aborting its response.
      reader.releaseLock();
    }
  }
}
