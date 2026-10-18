import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import { drainClaudePersistedOutput, tailClaudeTaskOutput } from "./ClaudeTaskOutputTail.ts";

const SESSION_ID = "0c91bb28-9e89-4889-bd22-3de9880233d3";
const TASK_ID = "bk6xreeye";

// Claude Code's layout: <root>/<project>/<session_id>/tasks/<task_id>.output.
const makeTaskFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
  const tasks = path.join(root, "-private-tmp-project", SESSION_ID, "tasks");
  return { root, tasks, file: path.join(tasks, `${TASK_ID}.output`) };
});

// Live clock and a real file: this proves the tail follows the writer, which
// TestClock cannot interleave with filesystem IO.
describe("tailClaudeTaskOutput", () => {
  it.live("follows a file that appears after the task starts, across split characters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<string | undefined>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);

        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // "é" is two bytes; the first write ends between them.
        const encoded = new TextEncoder().encode("café 1\n");
        yield* fileSystem.writeFile(file, encoded.subarray(0, 4));
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(file, encoded);
        assert.equal(yield* Queue.take(chunks), "é 1\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("skips ahead when the command writes faster than it is read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "start\n");
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<string | undefined>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "start\n");

        yield* fileSystem.writeFileString(file, `start\n${"y\n".repeat(1_000_000)}end\n`);
        const flooded = yield* Queue.take(chunks);
        assert.isAtMost(flooded.length, 256 * 1024 + 1);
        assert.isTrue(flooded.startsWith("\n"));
        assert.isTrue(flooded.endsWith("y\nend\n"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads what was written last when the tool result stops it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "one\n");
        const chunks: Array<string> = [];
        const stop = yield* Deferred.make<string | undefined>();
        const first = yield* Deferred.make<void>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) =>
            Effect.sync(() => chunks.push(chunk)).pipe(
              Effect.andThen(Deferred.succeed(first, undefined)),
            ),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(first);
        // Written right before the command exits, then the result arrives.
        yield* fileSystem.writeFileString(file, "one\ntwo\n");
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        assert.deepEqual(chunks, ["one\n", "two\n"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("ends when stopped even if Claude Code never wrote the file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = yield* makeTaskFile;
        const stop = yield* Deferred.make<string | undefined>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: () => Effect.die("no file, no output"),
        }).pipe(Effect.forkScoped);
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("drains the persisted full output when the task file keeps only its live prefix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, tasks, file } = yield* makeTaskFile;
        const prefix = "SB802_FRESH_LIVE\n";
        const output = `${prefix}${"x".repeat(75_000)}\nSB802_FRESH_TAIL\n`;
        const persisted = path.join(root, "full-output.txt");
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, prefix);
        const chunks: Array<string> = [];
        const first = yield* Deferred.make<void>();
        const stop = yield* Deferred.make<string | undefined>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) =>
            Effect.sync(() => chunks.push(chunk)).pipe(
              Effect.andThen(Deferred.succeed(first, undefined)),
            ),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(first);
        yield* fileSystem.writeFileString(persisted, output);
        yield* Deferred.succeed(stop, persisted);
        yield* Fiber.join(fiber);
        assert.isTrue(chunks.join("") === output);
        assert.equal(chunks.length, 2);
        assert.equal(yield* fileSystem.readFileString(file), prefix);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live.each([
    {
      name: "already captured",
      live: new TextEncoder().encode("already captured\n"),
      persisted: "already captured\n",
      extra: "",
    },
    {
      name: "missing file",
      live: new TextEncoder().encode("live\n"),
      persisted: undefined,
      extra: "",
    },
    {
      name: "different prefix with matching last 64 bytes",
      live: new TextEncoder().encode(`A${"x".repeat(100)}`),
      persisted: `B${"x".repeat(100)}tail`,
      extra: "",
    },
    {
      name: "shorter persisted output",
      live: new TextEncoder().encode("live\n"),
      persisted: "li",
      extra: "",
    },
    {
      name: "split UTF-8 character",
      live: new TextEncoder().encode("café").subarray(0, 4),
      persisted: "café final\n",
      extra: "é final\n",
    },
    {
      name: "prefix beyond the comparison budget",
      live: new TextEncoder().encode("x".repeat(256 * 1024 + 1)),
      persisted: `${"x".repeat(256 * 1024 + 1)}tail`,
      extra: "",
    },
  ])(
    "continues the persisted file only with byte-for-byte prefix proof: $name",
    ({ live, persisted, extra }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { root, tasks, file } = yield* makeTaskFile;
          const persistedPath = path.join(root, "full-output.txt");
          yield* fileSystem.makeDirectory(tasks, { recursive: true });
          yield* fileSystem.writeFile(file, live);
          if (persisted !== undefined) yield* fileSystem.writeFileString(persistedPath, persisted);
          const chunks: Array<string> = [];
          const first = yield* Deferred.make<void>();
          const stop = yield* Deferred.make<string | undefined>();
          const fiber = yield* tailClaudeTaskOutput({
            root,
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            stop,
            onChunk: (chunk) =>
              Effect.sync(() => chunks.push(chunk)).pipe(
                Effect.andThen(Deferred.succeed(first, undefined)),
              ),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(first);
          const before = chunks.join("");
          yield* Deferred.succeed(stop, persistedPath);
          yield* Fiber.join(fiber);
          assert.isTrue(chunks.join("") === before + extra);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.live("bounds persisted-file IO and still reaches the real tail without a live task", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root } = yield* makeTaskFile;
        const persisted = path.join(root, "full-output.txt");
        yield* fileSystem.writeFileString(persisted, `${"x".repeat(1_000_000)}\nACTUAL_TAIL\n`);
        const reads: Array<number> = [];
        const monitored = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) =>
            fileSystem.open(filePath, options).pipe(
              Effect.map(
                (handle) =>
                  ({
                    ...handle,
                    seek: (offset, from) => handle.seek(offset, from),
                    readAlloc: (size, options) => {
                      assert.isAtMost(size, 256 * 1024);
                      return handle.readAlloc(Math.min(size, 4096), options).pipe(
                        Effect.tap((chunk) =>
                          Effect.sync(() => {
                            if (Option.isSome(chunk)) reads.push(chunk.value.byteLength);
                          }),
                        ),
                      );
                    },
                  }) satisfies FileSystem.File,
              ),
            ),
        });
        const chunks: Array<string> = [];
        yield* drainClaudePersistedOutput({
          path: persisted,
          onChunk: (chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
            }),
        }).pipe(Effect.provideService(FileSystem.FileSystem, monitored));
        assert.isAtMost(
          reads.reduce((total, size) => total + size, 0),
          256 * 1024,
        );
        assert.isTrue(chunks.join("").endsWith("\nACTUAL_TAIL\n"));
        assert.isAtMost(chunks.join("").length, 256 * 1024 + 1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live.each([true, false])(
    "drains output when stopped before locating the task, persisted=%s",
    (hasPersisted) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { root, tasks, file } = yield* makeTaskFile;
          const persisted = path.join(root, "full-output.txt");
          yield* fileSystem.makeDirectory(tasks, { recursive: true });
          yield* fileSystem.writeFileString(hasPersisted ? persisted : file, "full output\n");
          const chunks: Array<string> = [];
          const stop = yield* Deferred.make<string | undefined>();
          yield* Deferred.succeed(stop, hasPersisted ? persisted : undefined);
          yield* tailClaudeTaskOutput({
            root,
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            stop,
            onChunk: (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk);
              }),
          });
          assert.deepEqual(chunks, ["full output\n"]);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );
});
