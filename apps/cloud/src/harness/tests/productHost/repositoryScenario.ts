import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";
import { ProviderSessionId } from "@t3tools/contracts";
import { CHILD_PROGRAM_PATHS } from "../../../computer/ChildProgramSet.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { createProductClaudeHarnessSessionHost } from "../../ProductClaudeHarnessSessionHost.ts";
import { pinnedGitCommandLoader } from "./commands.ts";
import { runGit, trackReadsFor } from "./gitRepository.ts";

export type RepositoryScenario =
  | "repository-readiness"
  | "repository-machine-rule"
  | "repository-failure"
  | "repository-cancel";

type ProductHost = Effect.Success<
  ReturnType<typeof createProductClaudeHarnessSessionHost<unknown>>
>;

export function runRepositoryScenario(
  scenario: RepositoryScenario,
  input: {
    readonly host: ProductHost;
    readonly session: Parameters<ProductHost["open"]>[0]["session"];
    readonly providerSessionId: ReturnType<typeof ProviderSessionId.make>;
    readonly systemIdentity: SystemIdentity;
    readonly nativeLaunched: () => boolean;
    readonly nativeAdapterBuilt: () => boolean;
    readonly machineRequests: readonly string[];
    readonly git: ReturnType<typeof pinnedGitCommandLoader>;
    readonly capacity: ChildWorkerCapacity;
    readonly repositoryCancelled: Promise<void>;
    readonly files: () => KernelFileSystem | undefined;
    readonly retainedFd: () => number | undefined;
    readonly repositoryReads: () => ReturnType<typeof trackReadsFor> | undefined;
    readonly indexLockExistsAfterGit: () => boolean | undefined;
  },
) {
  return Effect.gen(function* () {
    if (scenario === "repository-failure") {
      const outcome = yield* input.host
        .open({
          session: input.session,
          bootAttemptId: "locked-index-boot",
        })
        .pipe(Effect.exit);
      NodeAssert.equal(Exit.isFailure(outcome), true);
      NodeAssert.equal(input.nativeAdapterBuilt(), false);
      NodeAssert.equal(input.nativeLaunched(), false);
      NodeAssert.equal(input.git.commands.length, 1);
      NodeAssert.equal(input.git.commands[0]?.command.argv[1], "update-index");
      NodeAssert.notEqual(input.git.commands[0]?.exitCode, 0);
      NodeAssert.equal(input.capacity.active, 0);
      yield* input.host.dispose;
      return;
    }

    if (scenario === "repository-cancel") {
      let closed = false;
      const opening = yield* input.host
        .open({ session: input.session, bootAttemptId: "cancelled-index-boot" })
        .pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
          Effect.forkScoped,
        );
      yield* Effect.promise(() => input.git.entered);
      const interrupted = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
      yield* Effect.promise(() => input.repositoryCancelled);
      NodeAssert.equal(closed, false);
      NodeAssert.equal(input.nativeAdapterBuilt(), false);
      NodeAssert.equal(input.nativeLaunched(), false);
      const files = input.files();
      const retainedFd = input.retainedFd();
      NodeAssert.ok(files !== undefined && retainedFd !== undefined);
      files.fstat(retainedFd);
      NodeAssert.equal(input.git.commands.length, 0);
      input.git.release();
      yield* Fiber.join(interrupted);
      NodeAssert.equal(Exit.isFailure(yield* Fiber.await(opening)), true);
      NodeAssert.equal(input.git.commands.length, 1);
      NodeAssert.equal(input.indexLockExistsAfterGit(), false);
      NodeAssert.equal(input.capacity.active, 0);
      yield* input.host.dispose;
      NodeAssert.equal(files.descriptors.has(retainedFd), false);
      return;
    }

    const session = yield* input.host.open({
      session: input.session,
      bootAttemptId: "recorded-boot",
    });
    NodeAssert.deepEqual(input.host.commands.systemIdentity, input.systemIdentity);
    NodeAssert.equal(session.providerSession.id, input.providerSessionId);
    for (const executable of [
      ...Object.keys(CHILD_PROGRAM_PATHS),
      ...Object.values(CHILD_PROGRAM_PATHS),
    ])
      NodeAssert.equal(input.host.commands.host.resolve(executable).status, "ok");
    NodeAssert.equal(input.nativeAdapterBuilt(), true);
    NodeAssert.equal(input.nativeLaunched(), false);
    NodeAssert.equal(input.git.commands[0]?.command.argv[1], "update-index");
    NodeAssert.equal(input.git.commands[0]?.command.argv[2], "--refresh");
    NodeAssert.equal(input.git.commands[0]?.command.cwd, "/workspace");
    NodeAssert.equal(input.git.commands[0]?.command.env.GIT_CONFIG_GLOBAL, "/dev/null");
    NodeAssert.equal(input.git.commands[0]?.command.env.GIT_CONFIG_NOSYSTEM, "1");
    const reads = input.repositoryReads();
    NodeAssert.ok(reads !== undefined && reads.reads.length > 0);
    reads.clear();
    const args = ["--no-optional-locks", "status", "--short"] as const;
    const first = yield* Effect.promise(() => runGit(input.host.computer, args));
    const firstReads = [...reads.reads];
    reads.clear();
    const repeated = yield* Effect.promise(() => runGit(input.host.computer, args));
    const repeatedReads = [...reads.reads];
    NodeAssert.deepEqual(
      {
        first: { stdout: first.stdout, stderr: first.stderr, exitCode: first.exitCode },
        firstReads,
        repeated: {
          stdout: repeated.stdout,
          stderr: repeated.stderr,
          exitCode: repeated.exitCode,
        },
        repeatedReads,
      },
      {
        first: { stdout: "", stderr: "", exitCode: 0 },
        firstReads: [],
        repeated: { stdout: "", stderr: "", exitCode: 0 },
        repeatedReads: [],
      },
    );
    NodeAssert.equal(input.git.commands.length, 3);
    NodeAssert.deepEqual(input.machineRequests, []);
    yield* input.host.dispose;
  });
}
