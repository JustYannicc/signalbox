import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { createFacetSqliteStorage } from "../kernel/FacetSqliteStorage.ts";
import { createNodeFs } from "../isolate/NodeFs.ts";
import { createThreadClaudeSessions } from "./ThreadClaudeSessions.ts";
import * as SessionRows from "./ThreadSessionRows.ts";
import { facetSqlite } from "./tests/facetSqlite.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const thread = {
  driver,
  nativeThreadRef: { driver, nativeId: "native-session", strength: "strong" as const },
};
const main = "/home/.claude/projects/-workspace/native-session.jsonl";
const first = '{"type":"user","uuid":"one","message":{"content":"real transcript"}}';
const second = '{"type":"assistant","uuid":"two","message":{"content":"done"}}';
const layer = SessionRows.layer.pipe(
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const fixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(Effect.sync(facetSqlite), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => files.dispose()));
  const fs = createNodeFs(files).fs;
  fs.mkdirSync("/home/.claude/projects/-workspace/native-session/subagents", { recursive: true });
  fs.writeFileSync(main, `${first}\n`);
  const persistence = yield* createThreadClaudeSessions({
    files,
    configurationDirectory: "/home/.claude",
  });
  return { fs, persistence, sessions: yield* SessionRows.SessionRows };
});

describe("ThreadClaudeSessions", () => {
  it.effect("stores actual main and sidecar rows, then appends only the new prefix tail", () =>
    Effect.gen(function* () {
      const { fs, persistence, sessions } = yield* fixture;
      const sidecar = '{"type":"assistant","uuid":"child","opaque":{"signed":"kept"}}';
      fs.writeFileSync(`${main.slice(0, -6)}/subagents/agent-one.jsonl`, `${sidecar}\n`);
      yield* persistence.persist(thread);
      fs.appendFileSync(main, `${second}\n`);
      yield* persistence.persist(thread);
      yield* persistence.persist(thread);
      expect(yield* sessions.rows("claude/native-session", 0)).toEqual({
        rows: [first, second],
        more: false,
      });
      expect(yield* sessions.rows("claude/native-session/subagents/agent-one.jsonl", 0)).toEqual({
        rows: [sidecar],
        more: false,
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects a changed saved transcript prefix and preserves its committed rows", () =>
    Effect.gen(function* () {
      const { fs, persistence, sessions } = yield* fixture;
      yield* persistence.persist(thread);
      fs.writeFileSync(main, `${second}\n`);
      const error = yield* persistence.persist(thread).pipe(Effect.flip);
      expect(error.message).toBe("Claude transcript changed its already saved prefix.");
      expect((yield* sessions.rows("claude/native-session", 0)).rows).toEqual([first]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects missing or incomplete native rows instead of creating a marker", () =>
    Effect.gen(function* () {
      const { fs, persistence, sessions } = yield* fixture;
      fs.writeFileSync(main, '{"type":');
      yield* persistence.persist(thread).pipe(Effect.flip);
      fs.unlinkSync(main);
      yield* persistence.persist(thread).pipe(Effect.flip);
      expect(yield* sessions.streams("claude/")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
