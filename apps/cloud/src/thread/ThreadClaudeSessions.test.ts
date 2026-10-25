import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import {
  KernelFileSystemUnavailable,
  type KernelLowerFileSystemEntry,
} from "../kernel/KernelLowerFileSystem.ts";
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
  return { files, fs, persistence, sessions: yield* SessionRows.SessionRows };
});

describe("ThreadClaudeSessions", () => {
  it.effect("persists upper transcripts while lower directory metadata is asynchronous", () =>
    Effect.gen(function* () {
      const { files, persistence, sessions } = yield* fixture;
      const requests: string[] = [];
      const entries = new Map<string, KernelLowerFileSystemEntry>(
        ["/home/.claude/projects", "/home/.claude/projects/other"].map((path) => [
          path,
          {
            path,
            stat: { type: "directory", size: 0n, nlink: 2n, atimeNs: 1n, mtimeNs: 2n, ctimeNs: 3n },
            metadata: { mode: 0o755, uid: 1000, gid: 1000 },
          },
        ]),
      );
      const lower = files.installLowerFileSystem({
        lookupKnown: () => undefined,
        lookup: async (paths) => {
          requests.push(...paths);
          return paths.map((path) => entries.get(path));
        },
        readdir: async (path) =>
          [...entries.values()].filter(
            (entry) =>
              entry.path !== path && entry.path.slice(0, entry.path.lastIndexOf("/")) === path,
          ),
        read: async () => {
          throw new Error("Upper transcripts must keep their stored bytes");
        },
        readlink: async () => {
          throw new Error("No lower symlinks in this fixture");
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => lower.dispose()));
      yield* persistence.persist(thread);
      expect(requests).toContain("/home/.claude/projects");
      expect(requests).toContain("/home/.claude/projects/other/native-session.jsonl");
      expect((yield* sessions.rows("claude/native-session", 0)).rows).toEqual([first]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("rejects failed lower directory reads without saving a transcript", () =>
    Effect.gen(function* () {
      const { files, persistence, sessions } = yield* fixture;
      const unavailable = new KernelFileSystemUnavailable("transcript directory backend failed");
      const lower = files.installLowerFileSystem({
        lookup: async (paths) =>
          paths.map((path) => ({
            path,
            stat: {
              type: "directory" as const,
              size: 0n,
              nlink: 2n,
              atimeNs: 1n,
              mtimeNs: 1n,
              ctimeNs: 1n,
            },
            metadata: { mode: 0o755, uid: 0, gid: 0 },
          })),
        readdir: async () => {
          throw unavailable;
        },
        read: async () => {
          throw new Error("No transcript bytes should be read");
        },
        readlink: async () => {
          throw new Error("No transcript links should be read");
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => lower.dispose()));
      const error = yield* persistence.persist(thread).pipe(Effect.flip);
      expect(error.message).toBe("Could not locate the facet's Claude transcripts.");
      expect(error.cause).toBe(unavailable);
      expect(yield* sessions.streams("claude/")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("cancels an in-flight lower lookup without saving canonical rows", () =>
    Effect.gen(function* () {
      const { files, persistence, sessions } = yield* fixture;
      const started = Promise.withResolvers<AbortSignal | undefined>();
      const lower = files.installLowerFileSystem({
        lookup: (_paths, signal) =>
          new Promise((_resolve, reject) => {
            started.resolve(signal);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        readdir: async () => [],
        read: async () => {
          throw new Error("Cancelled lookup must not read transcript bytes");
        },
        readlink: async () => {
          throw new Error("No transcript links should be read");
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => lower.dispose()));
      const running = yield* persistence.persist(thread).pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(running);
      expect(signal?.aborted).toBe(true);
      expect(yield* sessions.streams("claude/")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

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
