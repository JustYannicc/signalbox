// Test-only fixture for PullRequestThreadPreparation.test.ts.
import {
  type GitPreparePullRequestThreadInput,
  type OrchestrationV2Command,
  type OrchestrationV2DispatchCommandResult,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadLaunchResult,
} from "@t3tools/contracts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Platform from "../platform.ts";
import { DriveDirectory, DriveObjectError } from "../drive/DriveDirectory.ts";
import * as Environment from "../environment.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import {
  ThreadCommandRejectedError,
  ThreadNotFoundError,
  type Actor,
} from "../thread/ThreadAccess.ts";
import * as UserDrives from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import type { GitHubApi } from "./GitHubApi.ts";
import * as PullRequestRepository from "./PullRequestRepository.ts";
import { makePullRequestThreadPreparation } from "./PullRequestThreadPreparation.ts";

export const actor: Actor = { userId: "owner", contextIds: [] };
export const projectId = Environment.SCRATCH_PROJECT_ID;
export const headA = "a".repeat(40);
export const headB = "b".repeat(40);

type Stage = "drive" | "launch" | "link";

export const makeInput = (
  operationId = "prepare-operation-1",
  overrides: Partial<GitPreparePullRequestThreadInput> = {},
): GitPreparePullRequestThreadInput => ({
  cwd: Environment.scratchProject.workspaceRoot,
  reference: "12",
  mode: "worktree",
  operationId,
  ...overrides,
});

const makePullRequest = (state: HarnessState) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 12,
          title: state.title,
          url: "https://github.com/Acme/Web/pull/12",
          state: "OPEN",
          baseRefName: "main",
          headRefName: "feature/pr-12",
          headRefOid: state.headSha,
        },
      },
    },
  });

interface HarnessState {
  userId: string | null;
  role: SignalboxDriveRole | null;
  repository: string;
  host: string;
  accountId: string;
  headSha: string;
  title: string;
  readonly failures: Record<Stage, number>;
  readonly githubQueries: Array<{
    readonly token: string;
    readonly variables: Readonly<Record<string, unknown>>;
  }>;
  readonly driveRequests: Array<{
    readonly userId: string;
    readonly request: {
      readonly operationId: string;
      readonly threadId: string;
      readonly repository: string;
      readonly number: number;
      readonly headSha: string;
    };
  }>;
  readonly driveObservedSelections: Array<string | null>;
  readonly seeds: Map<string, string>;
  readonly launchInputs: Array<OrchestrationV2ThreadLaunchInput>;
  readonly dispatchInputs: Array<OrchestrationV2Command>;
  readonly threads: Map<
    string,
    {
      readonly projectId: ProjectId;
      readonly runs: ReadonlyArray<unknown>;
      readonly pullRequests?: ReadonlyArray<unknown>;
      visible: boolean;
    }
  >;
  readonly linkReceipts: Map<string, unknown>;
  driveAccessCalls: number;
  repositoryCalls: number;
}

export const makeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state: HarnessState = {
    userId: actor.userId,
    role: "owner",
    repository: "Acme/Web",
    host: "github.com",
    accountId: "account-A",
    headSha: headA,
    title: "Prepare PR 12",
    failures: { drive: 0, launch: 0, link: 0 },
    githubQueries: [],
    driveRequests: [],
    driveObservedSelections: [],
    seeds: new Map(),
    launchInputs: [],
    dispatchInputs: [],
    threads: new Map(),
    linkReceipts: new Map(),
    driveAccessCalls: 0,
    repositoryCalls: 0,
  };

  const project = { ...Environment.scratchProject, id: projectId };
  const repository = PullRequestRepository.PullRequestRepository.of({
    projects: Effect.succeed([project]),
    forProject: () =>
      Effect.sync(() => {
        state.repositoryCalls += 1;
        return {
          project,
          repository: state.repository,
          host: state.host,
          token: "github-token",
          viewer: "owner",
          accountId: state.accountId,
        };
      }),
    resolve: () => Effect.die("unused"),
    identity: (host) =>
      Effect.succeed({
        host,
        provider: "github" as const,
        accountId: state.accountId,
        viewer: "owner",
      }),
  });

  const userDrives = UserDrives.UserDrives.of({
    userId: Effect.sync(() => state.userId),
    contextIds: Effect.succeed([]),
    drives: Effect.succeed([]),
    changes: Stream.empty,
    changed: Stream.empty,
    access: () =>
      Effect.sync(() => {
        state.driveAccessCalls += 1;
        return state.role;
      }),
  });

  const api = {
    host: "github.com",
    graphql: (
      _operation: string,
      token: string,
      _query: string,
      variables: Readonly<Record<string, unknown>>,
    ) =>
      Effect.sync(() => {
        state.githubQueries.push({ token, variables });
        return makePullRequest(state);
      }),
  } as unknown as GitHubApi;

  const threadLayer = Layer.mock(CloudThreadService, {
    threadSnapshot: (_actingUser, threadId) => {
      const existing = state.threads.get(threadId);
      if (existing === undefined || !existing.visible)
        return Effect.fail(new ThreadNotFoundError({}));
      return Effect.succeed({
        snapshotSequence: 0,
        projection: {
          thread: { projectId: existing.projectId, pullRequests: existing.pullRequests },
          runs: existing.runs,
        },
        historyCursor: null,
        hasMoreHistory: false,
        latestLocalTurnOrdinal: null,
      } as unknown as OrchestrationV2ThreadBoundedSnapshot);
    },
    launchThread: (_actingUser, input) => {
      state.launchInputs.push(input);
      const threadId = input.threadId ?? ThreadId.make("missing-thread-id");
      state.threads.set(threadId, {
        projectId: input.projectId,
        runs: [],
        visible: true,
      });
      if (state.failures.launch > 0) {
        state.failures.launch -= 1;
        return Effect.fail(
          new ThreadCommandRejectedError({
            commandId: input.commandId,
            commandType: "thread.launch",
            reason: "launch response lost",
          }),
        );
      }
      return Effect.succeed({
        threadId,
        projection: {} as OrchestrationV2ThreadLaunchResult["projection"],
        resumed: false,
      } satisfies OrchestrationV2ThreadLaunchResult);
    },
    dispatchCommand: (_actingUser, command) => {
      state.dispatchInputs.push(command);
      if (command.type === "thread.pull-request.link") {
        state.linkReceipts.set(command.commandId, command);
        if (state.failures.link > 0) {
          state.failures.link -= 1;
          return Effect.fail(
            ThreadCommandRejectedError.forCommand(
              { id: command.commandId, type: command.type },
              "link response lost",
            ),
          );
        }
      }
      return Effect.succeed({ sequence: 1 } satisfies OrchestrationV2DispatchCommandResult);
    },
  });

  const driveService = DriveDirectory.of({
    forDrive: () =>
      ({
        prepareThread: (
          _userId: string,
          request: HarnessState["driveRequests"][number]["request"],
        ) =>
          Effect.gen(function* () {
            state.driveRequests.push({ userId: _userId, request });
            const rows = yield* sql<{ readonly selection: string }>`
              SELECT selection FROM pull_request_thread_preparations
              WHERE operation_id = ${request.operationId}
            `;
            state.driveObservedSelections.push(rows[0]?.selection ?? null);
            state.seeds.set(request.threadId, request.headSha);
            if (state.failures.drive > 0) {
              state.failures.drive -= 1;
              return yield* new DriveObjectError({
                operation: "prepareThread",
                cause: new Error("response lost"),
              });
            }
            return { _tag: "ok" } as const;
          }),
      }) as ReturnType<DriveDirectory["Service"]["forDrive"]>,
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, sql),
    Platform.layerCrypto,
    Layer.succeed(GitHub, GitHub.of({ pipesForUser: () => Effect.succeed(null), api })),
    Layer.succeed(PullRequestRepository.PullRequestRepository, repository),
    Layer.succeed(UserDrives.UserDrives, userDrives),
    Layer.succeed(DriveDirectory, driveService),
    threadLayer,
  );
  const prepare = yield* makePullRequestThreadPreparation.pipe(Effect.provide(dependencies));

  return { prepare, state, sql };
});

export const receipt = (sql: SqlClient.SqlClient, operationId: string) =>
  sql<{
    readonly request_key: string;
    readonly selection: string;
    readonly launch_started: number;
    readonly completed: number;
  }>`SELECT request_key, selection, launch_started, completed
      FROM pull_request_thread_preparations WHERE operation_id = ${operationId}`;

export const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
