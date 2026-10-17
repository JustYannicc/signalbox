// @effect-diagnostics nodeBuiltinImport:off - holds a real writer descriptor to catch inode swaps.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
const setup = (
  stored: Record<string, ReadonlyArray<string>>,
  cwdMigration?: { readonly from: string; readonly to: string },
) =>
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
    const rollouts = yield* makeCodexRollouts({
      codexHome,
      client: store.client,
      outbox,
      ...(cwdMigration === undefined ? {} : { cwdMigration }),
    });
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

  it.live("rebases restored Codex session paths and keeps the durable rows unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const from = "/home/user/signalbox/workspaces/thread:abc/drive";
        const to = "/home/user/signalbox/workspaces/encoded/dGhyZWFkOmFiYw/drive";
        const sessionMeta = JSON.stringify({
          type: "session_meta",
          payload: { id: "session-1", cwd: from },
        });
        const message = JSON.stringify({ type: "event_msg", payload: { text: "saved" } });
        const { fs, file, store, rollouts, append } = yield* setup(
          { [STREAM]: [sessionMeta, message] },
          { from, to },
        );

        yield* rollouts.restore;
        const restored = (yield* fs.readFileString(file)).trimEnd().split("\n");
        expect(JSON.parse(restored[0]!)).toEqual({
          type: "session_meta",
          payload: { id: "session-1", cwd: to },
        });
        expect(restored[1]).toBe(message);
        expect(store.streams.get(STREAM)).toEqual([sessionMeta, message]);

        yield* append('{"type":"event_msg","payload":{"text":"new"}}\n');
        yield* rollouts.settle(10_000);
        expect(store.streams.get(STREAM)).toEqual([
          sessionMeta,
          message,
          '{"type":"event_msg","payload":{"text":"new"}}',
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rebases a rollout already on the machine before Codex reads it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const from = "/home/user/signalbox/workspaces/thread:abc/drive";
        const to = "/home/user/signalbox/workspaces/encoded/dGhyZWFkOmFiYw/drive";
        const sessionMeta = JSON.stringify({
          type: "session_meta",
          payload: { id: "session-1", cwd: from },
        });
        const message = JSON.stringify({ type: "event_msg", payload: { text: "saved" } });
        const { fs, file, rollouts, append } = yield* setup(
          { [STREAM]: [sessionMeta, message] },
          { from, to },
        );
        yield* append(`${sessionMeta}\n${message}\n`);

        yield* rollouts.restore;
        const restored = (yield* fs.readFileString(file)).trimEnd().split("\n");
        expect(JSON.parse(restored[0]!)).toEqual({
          type: "session_meta",
          payload: { id: "session-1", cwd: to },
        });
        expect(restored[1]).toBe(message);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps an open provider writer attached while live tailing a new rollout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const from = "/home/user/signalbox/workspaces/thread:abc/drive";
        const to = "/home/user/signalbox/workspaces/encoded/dGhyZWFkOmFiYw/drive";
        const { fs, file, store, rollouts } = yield* setup({}, { from, to });
        yield* rollouts.restore;

        const sessionMeta = JSON.stringify({
          type: "session_meta",
          payload: { id: "session-2", cwd: from },
        });
        yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, `${sessionMeta}\n`);
        const writer = NodeFS.openSync(file, "a");
        try {
          const inode = NodeFS.statSync(file).ino;
          yield* rollouts.settle(10_000);
          expect(NodeFS.statSync(file).ino).toBe(inode);

          const newRow = JSON.stringify({ type: "event_msg", payload: { text: "still attached" } });
          NodeFS.writeSync(writer, `${newRow}\n`);
          yield* rollouts.settle(10_000);
          expect(store.streams.get(STREAM)).toEqual([sessionMeta, newRow]);
        } finally {
          NodeFS.closeSync(writer);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
