import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
