import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "@effect/vitest";

import { type AgentCleanup, makeAgentCleanup } from "./agentCleanup.ts";

const withRemovalGate = <A, E, R>(
  service: AgentCleanup["Service"],
  worktreePath: string,
  removal: (commonDir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const gate = yield* service.acquireWorktreeRemovalGate(worktreePath);
    if (Option.isNone(gate)) return Option.none();
    return Option.some(yield* removal(gate.value));
  }).pipe(Effect.scoped);

describe("agent process cleanup", () => {
  it.effect("preserves Windows worktree cleanup only for an empty registry", () =>
    Effect.gen(function* () {
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        processRegistrationSupported: false,
        registry: {
          closeWorktree: async () => {
            throw new Error("Windows cannot identify the cleanup process");
          },
          reap: async () => undefined,
          status: async ({ worktreePath, commonDir }) => {
            expect(worktreePath).toBe("/worktrees/feature");
            expect(commonDir).toBe("/repo/.git");
            return [];
          },
        },
        sessions: async () => [],
      });

      const result = yield* withRemovalGate(service, "/worktrees/feature", () =>
        Effect.succeed("removed"),
      );
      expect(Option.getOrNull(result)).toBe("removed");
    }),
  );

  it.effect.each([
    { name: "registered process", status: async () => [{ state: "exited" }] },
    {
      name: "unavailable registry",
      status: async () => {
        throw new Error("registry unavailable");
      },
    },
  ])("blocks Windows cleanup for %s", ({ status }) =>
    Effect.gen(function* () {
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        processRegistrationSupported: false,
        registry: {
          closeWorktree: async () => {
            throw new Error("must not acquire an identity gate");
          },
          reap: async () => undefined,
          status,
        },
        sessions: async () => [],
      });

      let removed = false;
      const result = yield* withRemovalGate(service, "/worktrees/feature", () =>
        Effect.sync(() => {
          removed = true;
        }),
      );
      expect(Option.isNone(result)).toBe(true);
      expect(removed).toBe(false);
    }),
  );

  it.effect("holds registration closed through reaping and survivor checks", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        registry: {
          closeWorktree: async (worktreePath) => {
            calls.push(`close:${worktreePath}`);
            return {
              commonDir: "/repo/.git",
              release: async () => {
                calls.push("release");
              },
            };
          },
          reap: async ({ commonDir, isSessionEnded }) => {
            calls.push(`reap:${commonDir}`);
            expect(await isSessionEnded("session-1", "/worktrees/feature")).toBe(true);
            expect(await isSessionEnded("session-1", "/worktrees/other")).toBe(false);
          },
          status: async ({ worktreePath, commonDir }) => {
            calls.push(`status:${worktreePath}:${commonDir}`);
            return [{ state: "running" }];
          },
        },
        sessions: async (worktreePath) =>
          worktreePath === "/worktrees/feature" ? [{ sessionId: "session-1", ended: true }] : [],
      });

      let removalRan = false;
      const result = yield* withRemovalGate(service, "/worktrees/feature", (commonDir) =>
        Effect.sync(() => {
          calls.push(`remove:${commonDir}`);
          removalRan = true;
        }),
      );
      expect(Option.isNone(result)).toBe(true);
      expect(removalRan).toBe(false);
      expect(calls).toEqual([
        "close:/worktrees/feature",
        "reap:/repo/.git",
        "status:/worktrees/feature:/repo/.git",
        "release",
      ]);
    }),
  );

  it.effect.each(["unknown", "cwd-mismatch"] as const)(
    "retains a worktree while process status is %s",
    (state) =>
      Effect.gen(function* () {
        const service = makeAgentCleanup({
          commonDirectory: () => Effect.succeed("/repo/.git"),
          registry: {
            closeWorktree: async () => ({
              commonDir: "/repo/.git",
              release: async () => undefined,
            }),
            reap: async () => undefined,
            status: async () => [{ state }],
          },
          sessions: async () => [],
        });

        let removalRan = false;
        const result = yield* withRemovalGate(service, "/worktrees/feature", () =>
          Effect.sync(() => {
            removalRan = true;
          }),
        );
        expect(Option.isNone(result)).toBe(true);
        expect(removalRan).toBe(false);
      }),
  );

  it.effect("allows only exited or reused records after a targeted reap", () =>
    Effect.gen(function* () {
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        registry: {
          closeWorktree: async () => ({
            commonDir: "/repo/.git",
            release: async () => undefined,
          }),
          reap: async () => undefined,
          status: async () => [{ state: "exited" }, { state: "reused" }],
        },
        sessions: async () => [],
      });

      const result = yield* withRemovalGate(service, "/worktrees/feature", () =>
        Effect.succeed("removed"),
      );
      expect(Option.getOrNull(result)).toBe("removed");
    }),
  );

  it.effect("fails closed when process status cannot be read", () =>
    Effect.gen(function* () {
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        registry: {
          closeWorktree: async () => ({
            commonDir: "/repo/.git",
            release: async () => undefined,
          }),
          reap: async () => undefined,
          status: async () => {
            throw new Error("registry unavailable");
          },
        },
        sessions: async () => [],
      });

      const result = yield* withRemovalGate(service, "/worktrees/feature", () =>
        Effect.succeed("removed"),
      );
      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("releases the gate if the removal effect fails", () =>
    Effect.gen(function* () {
      let released = false;
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        registry: {
          closeWorktree: async () => ({
            commonDir: "/repo/.git",
            release: async () => {
              released = true;
            },
          }),
          reap: async () => undefined,
          status: async () => [],
        },
        sessions: async () => [],
      });

      const exit = yield* withRemovalGate(service, "/worktrees/feature", () =>
        Effect.fail("git remove failed"),
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      expect(released).toBe(true);
    }),
  );

  it.effect("releases the gate if cleanup is interrupted", () =>
    Effect.gen(function* () {
      const enteredRemoval = yield* Deferred.make<void>();
      let released = false;
      const service = makeAgentCleanup({
        commonDirectory: () => Effect.succeed("/repo/.git"),
        registry: {
          closeWorktree: async () => ({
            commonDir: "/repo/.git",
            release: async () => {
              released = true;
            },
          }),
          reap: async () => undefined,
          status: async () => [],
        },
        sessions: async () => [],
      });

      const fiber = yield* withRemovalGate(service, "/worktrees/feature", () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(enteredRemoval, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(enteredRemoval);
      yield* Fiber.interrupt(fiber);
      expect(released).toBe(true);
    }),
  );
});
