import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeCodexRollouts } from "./RunnerCodexRollouts.ts";
import { makeSessionOutbox } from "./RunnerSessionOutbox.ts";
import { makeMemorySessionStore } from "./sessionStoreTesting.ts";

const ROLLOUT = "2026/10/08/rollout-2026-10-08T10-00-00-thread.jsonl";
const STREAM = `codex/${ROLLOUT}`;

/** Codex's home on a fresh temporary disk, with the store and tailer around it. */
const setup = (stored: Record<string, ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = yield* fs.makeTempDirectoryScoped();
    const file = path.join(codexHome, "sessions", ROLLOUT);
    const store = makeMemorySessionStore(stored);
    const outbox = yield* makeSessionOutbox({
      client: store.client,
      stallAfterMs: 60_000,
      onFailure: () => Effect.void,
    });
    const rollouts = yield* makeCodexRollouts({ codexHome, client: store.client, outbox });
    const append = (text: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        const before = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
        yield* fs.writeFileString(file, before + text);
      });
    return { fs, file, store, rollouts, append };
  });

describe("RunnerCodexRollouts", () => {
  it.live(
    "puts a stored rollout back on a new machine's disk, then sends only new complete lines",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fs, file, store, rollouts, append } = yield* setup({
            [STREAM]: ['{"type":"session_meta"}', '{"encrypted_content":"gAAA"}'],
          });
          yield* rollouts.restore;
          expect(yield* fs.readFileString(file)).toBe(
            '{"type":"session_meta"}\n{"encrypted_content":"gAAA"}\n',
          );

          // Codex goes on writing; half a line is not a row yet.
          yield* append('{"n":3}\n{"n":');
          yield* rollouts.settle(10_000);
          expect(store.streams.get(STREAM)).toHaveLength(3);
          yield* append("4}\n");
          yield* rollouts.settle(10_000);
          expect(store.streams.get(STREAM)?.slice(2)).toEqual(['{"n":3}', '{"n":4}']);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("sends a disk that is ahead of the store once, from where the store stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, rollouts, append } = yield* setup({ [STREAM]: ['{"n":1}'] });
        yield* append('{"n":1}\n{"n":2}\n{"n":3}\n');
        yield* rollouts.restore;
        yield* rollouts.settle(10_000);
        yield* rollouts.settle(10_000);
        expect(store.streams.get(STREAM)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
