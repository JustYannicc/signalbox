// @effect-diagnostics nodeBuiltinImport:off - Effect Crypto has no incremental digest for bounded-memory evidence streams.
import * as NodeCrypto from "node:crypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

export type LocalEvidenceFile = {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
};

class LocalEvidenceInputError extends Data.TaggedError("LocalEvidenceInputError")<{
  readonly cause: unknown;
}> {}

const localFiles = Layer.merge(NodeFileSystem.layer, NodePath.layer);

export function readLocalEvidenceChunks(directory: string, name: string) {
  return Stream.toAsyncIterable(
    Stream.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return fs.stream(path.join(directory, name), { chunkSize: 64 * 1024 });
      }),
    ).pipe(Stream.provide(localFiles)),
  );
}

export function hashLocalEvidenceFile(
  directory: string,
  name: string,
): Promise<Omit<LocalEvidenceFile, "name">> {
  return digestLocalEvidenceChunks(directory, [name]);
}

export async function digestLocalEvidenceChunks(directory: string, names: readonly string[]) {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  for (const name of names) {
    for await (const chunk of readLocalEvidenceChunks(directory, name)) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function writeLocalEvidenceChunks(
  directory: string,
  name: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<LocalEvidenceFile> {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* fs.open(path.join(directory, name), { flag: "wx", mode: 0o600 });
      yield* Stream.runForEach(
        Stream.fromAsyncIterable(chunks, (cause) => new LocalEvidenceInputError({ cause })),
        (chunk) =>
          file.writeAll(chunk).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                hash.update(chunk);
                bytes += chunk.byteLength;
              }),
            ),
          ),
      );
      yield* file.sync;
    }).pipe(Effect.scoped, Effect.provide(localFiles)),
  );
  const sha256 = hash.digest("hex");
  const readback = await hashLocalEvidenceFile(directory, name);
  if (readback.bytes !== bytes || readback.sha256 !== sha256) {
    throw new Error("Local streamed export readback differs");
  }
  return { name, bytes, sha256 };
}

export async function saveLocalEvidenceBytes(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<LocalEvidenceFile> {
  await writeLocalEvidenceBytes(directory, name, bytes);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const readback = await hashLocalEvidenceFile(directory, name);
  if (readback.bytes !== bytes.byteLength || readback.sha256 !== sha256) {
    throw new Error("Local export readback differs");
  }
  return { name, bytes: bytes.byteLength, sha256 };
}

export function createLocalEvidenceDirectory(directory: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(directory, { mode: 0o700 });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

export function readLocalEvidenceBytes(directory: string, name: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fs.readFile(path.join(directory, name));
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );
}

export function readLocalEvidenceText(file: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(file);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

export function writeLocalEvidenceBytes(directory: string, name: string, bytes: Uint8Array) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* fs.open(path.join(directory, name), { flag: "wx", mode: 0o600 });
      yield* file.writeAll(bytes);
      yield* file.sync;
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );
}

export function syncLocalEvidenceDirectory(directory: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.open(directory, { flag: "r" });
      yield* file.sync;
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
}
