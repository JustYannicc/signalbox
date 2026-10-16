// @effect-diagnostics cryptoRandomUUID:off cryptoRandomUUIDInEffect:off - fake secrets are generated per run, so no test ever holds a real one.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import { makeHarnessStderr } from "./harnessStderr.ts";
import { makeSecretMask } from "./secretMask.ts";

/** A spawner whose every process writes `chunks` to stderr and exits 1. */
const layerFakeSpawner = (chunks: ReadonlyArray<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.fromIterable(chunks)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );

/** Spawns `command` and drains its stderr, as upstream's Codex client does. */
const spawnAndDrain = (command: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(command, ["app-server"]));
      yield* Stream.runDrain(handle.stderr);
    }),
  );

describe("harnessStderr", () => {
  it.effect("keeps each process's stderr lines, scoped to a turn by its mark", () =>
    Effect.gen(function* () {
      const stderr = makeHarnessStderr();
      const before = stderr.mark();
      yield* spawnAndDrain("/usr/local/bin/codex").pipe(
        Effect.provide(
          stderr.layerSpawner.pipe(
            Layer.provide(
              layerFakeSpawner(["Error: failed to init", "ialize sqlite\nretry\n\n", "bye"]),
            ),
          ),
        ),
      );
      // Split across chunks, blank lines dropped, the unterminated last line kept at the end.
      expect(stderr.since(before)).toBe(
        "[codex] Error: failed to initialize sqlite\n[codex] retry\n[codex] bye",
      );
      expect(stderr.since(stderr.mark())).toBe("");
    }),
  );

  it.effect("masks a secret before a long line is cut, so no piece of it is kept", () =>
    Effect.gen(function* () {
      const value = `sk-fake-${crypto.randomUUID()}`;
      const mask = makeSecretMask();
      mask.add([{ name: "API_KEY", value }]);
      const stderr = makeHarnessStderr(mask.text);
      // The value straddles the 500th character, where the line is cut.
      const line = `${"x".repeat(480)}${value} trailing`;
      yield* spawnAndDrain("codex").pipe(
        Effect.provide(stderr.layerSpawner.pipe(Layer.provide(layerFakeSpawner([`${line}\n`])))),
      );

      const kept = stderr.since(0);
      expect(kept).toContain("{{secret:API_KEY}}");
      expect(kept).not.toContain(value.slice(0, 10));
    }),
  );
});
