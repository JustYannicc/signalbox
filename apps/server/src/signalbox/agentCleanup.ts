import {
  closeWorktree as registryCloseWorktree,
  reap as registryReap,
  status as registryStatus,
} from "@t3tools/shared/agentProcesses";
import { sessions as readSessions } from "@t3tools/shared/agentProcessSessions";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";

export class AgentCleanup extends Context.Service<
  AgentCleanup,
  {
    readonly withWorktreeRemovalGate: <A, E, R>(
      worktreePath: string,
      removal: (commonDir: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
    readonly reap: (workspaceRoots: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("t3/signalbox/agentCleanup") {}

type AgentCleanupRegistry = {
  readonly reap: (input: {
    readonly commonDir: string;
    readonly isSessionEnded: (sessionId: string, worktreePath: string) => Promise<boolean>;
  }) => Promise<unknown>;
  readonly closeWorktree: (worktreePath: string) => Promise<{
    readonly commonDir: string;
    readonly release: () => Promise<void>;
  }>;
  readonly status: (input: {
    readonly worktreePath: string;
    readonly commonDir: string;
  }) => Promise<ReadonlyArray<{ readonly state: string }>>;
};

type AgentCleanupDependencies = {
  readonly commonDirectory: (workspaceRoot: string) => Effect.Effect<string | null>;
  readonly processRegistrationSupported?: boolean;
  readonly registry?: AgentCleanupRegistry;
  readonly sessions?: (worktreePath: string) => ReturnType<typeof readSessions>;
};

export const makeAgentCleanup = ({
  commonDirectory,
  processRegistrationSupported = true,
  registry = {
    reap: registryReap,
    status: registryStatus,
    closeWorktree: registryCloseWorktree,
  },
  sessions = readSessions,
}: AgentCleanupDependencies): AgentCleanup["Service"] => {
  const reapCommonDirectory = Effect.fn("agentCleanup.reapCommonDirectory")(function* (
    commonDir: string,
  ) {
    yield* Effect.tryPromise(() =>
      registry.reap({
        commonDir,
        isSessionEnded: async (sessionId, worktreePath) =>
          (await sessions(worktreePath)).some(
            (session) => session.sessionId === sessionId && session.ended,
          ),
      }),
    ).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not reap registered worktree processes", { commonDir }),
      ),
    );
  });

  const withWorktreeRemovalGate = Effect.fn("agentCleanup.withWorktreeRemovalGate")(function* <
    A,
    E,
    R,
  >(worktreePath: string, removal: (commonDir: string) => Effect.Effect<A, E, R>) {
    if (!processRegistrationSupported) {
      // Windows cannot identify registered processes. Preserve its existing
      // worktree cleanup only when there are no records to verify.
      const commonDir = yield* commonDirectory(worktreePath);
      if (commonDir === null) return Option.none();
      const records = yield* Effect.tryPromise(() =>
        registry.status({ worktreePath, commonDir }),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not verify registered worktree processes", {
            worktreePath,
          }).pipe(Effect.as(null)),
        ),
      );
      if (records === null || records.length > 0) return Option.none();
      return Option.some(yield* removal(commonDir));
    }

    // acquireUseRelease keeps closing registration uninterruptible and releases
    // the gate if cleanup is interrupted after it has closed.
    const result = yield* Effect.acquireUseRelease(
      Effect.tryPromise(() => registry.closeWorktree(worktreePath)).pipe(
        Effect.map(Option.some),
        Effect.catch(() =>
          Effect.logWarning("Could not close worktree process registration", {
            worktreePath,
          }).pipe(Effect.as(Option.none())),
        ),
      ),
      (leaseOption) =>
        Option.match(leaseOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (lease) =>
            Effect.gen(function* () {
              yield* reapCommonDirectory(lease.commonDir);
              const records = yield* Effect.tryPromise(() =>
                registry.status({ worktreePath, commonDir: lease.commonDir }),
              ).pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not verify registered worktree processes", {
                    worktreePath,
                  }).pipe(Effect.as(null)),
                ),
              );
              if (
                records === null ||
                !records.every((record) => record.state === "exited" || record.state === "reused")
              )
                return Option.none();
              return yield* removal(lease.commonDir).pipe(Effect.map(Option.some));
            }),
        }),
      (leaseOption) =>
        Option.match(leaseOption, {
          onNone: () => Effect.void,
          onSome: ({ release }) =>
            Effect.tryPromise(() => release()).pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not reopen worktree process registration", {
                  worktreePath,
                }),
              ),
            ),
        }),
    );
    return result;
  });

  const reapWorkspaces = Effect.fn("agentCleanup.reap")(function* (
    workspaceRoots: ReadonlyArray<string>,
  ) {
    const commonDirectories = new Set<string>();
    for (const workspaceRoot of workspaceRoots) {
      const commonDir = yield* commonDirectory(workspaceRoot);
      if (commonDir !== null) commonDirectories.add(commonDir);
    }
    for (const commonDir of commonDirectories) yield* reapCommonDirectory(commonDir);
  });

  return { withWorktreeRemovalGate, reap: reapWorkspaces };
};

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWindows = yield* HostProcess.isWindows;
  const commonDirectory = Effect.fn("agentCleanup.commonDirectory")(function* (cwd: string) {
    return yield* runner
      .run({
        command: "git",
        args: ["rev-parse", "--git-common-dir"],
        cwd,
        timeout: "2 seconds",
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0 && result.stdout.trim().length > 0
            ? fs.realPath(path.resolve(cwd, result.stdout.trim()))
            : Effect.succeed(null),
        ),
        Effect.orElseSucceed(() => null),
      );
  });
  return AgentCleanup.of(
    makeAgentCleanup({ commonDirectory, processRegistrationSupported: !isWindows }),
  );
});

export const layer = Layer.effect(AgentCleanup, make);
