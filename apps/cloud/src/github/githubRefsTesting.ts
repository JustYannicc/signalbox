import { OrchestrationV2ThreadBoundedSnapshot, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import { DriveDirectory, type DriveHandle, DriveObjectError } from "../drive/DriveDirectory.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { ThreadNotFoundError } from "../thread/ThreadAccess.ts";
import { driveRoot, projectIdForDrive, remoteThreadWorktree } from "../user/contextProjects.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { GitHub } from "./GitHub.ts";
import { makeGitHubApi } from "./GitHubApi.ts";
import { GitHubConnection } from "./GitHubConnection.ts";
import { makeGitHubRefs } from "./GitHubRefs.ts";

export const driveId = "folder/personal/repository";
export const root = driveRoot(driveId);
export const threadId = ThreadId.make("thread-one");
export const current = remoteThreadWorktree(driveId, threadId);
export const actor = { userId: "user-one", contextIds: [PERSONAL_CONTEXT_ID] };

const now = DateTime.makeUnsafe(0);
const snapshot = Schema.decodeUnknownSync(OrchestrationV2ThreadBoundedSnapshot)({
  snapshotSequence: 1,
  historyCursor: null,
  hasMoreHistory: false,
  latestLocalTurnOrdinal: null,
  projection: {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: projectIdForDrive(driveId),
      title: "Work",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: current.branch,
      worktreePath: current.path,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  },
});

class TestDrive extends Context.Service<TestDrive, DriveHandle>()("test/GitHubRefs/Drive") {}

export const fixture = Effect.gen(function* () {
  const state = {
    role: "viewer" as SignalboxDriveRole | null,
    token: "github-token" as string | null,
    imported: true,
    main: "a".repeat(40) as string | null,
    defaultBranch: "main",
    branches: ["main", "feature/Alpha", "release", current.branch],
    repositoryStatus: 200,
    refsStatus: 200,
    threadVisible: true,
    threadProjectId: projectIdForDrive(driveId),
    threadBranch: current.branch as string | null,
    threadPath: current.path as string | null,
    driveFailure: false,
    folderChecks: 0,
    threadChecks: 0,
    remoteReads: 0,
    requests: [] as Array<{ url: string; token: string | undefined }>,
  };
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      state.requests.push({ url: request.url, token: request.headers.authorization });
      const isRefs = request.url.endsWith("/git/matching-refs/heads/");
      const status = isRefs ? state.refsStatus : state.repositoryStatus;
      const body =
        status !== 200
          ? { message: "GitHub refused this read." }
          : isRefs
            ? state.branches.map((name) => ({
                ref: `refs/heads/${name}`,
                object: { sha: "b".repeat(40) },
              }))
            : {
                id: 1,
                full_name: "owner/repository",
                name: "repository",
                default_branch: state.defaultBranch,
                html_url: "https://github.com/owner/repository",
                clone_url: "https://github.com/owner/repository.git",
                ssh_url: "git@github.com:owner/repository.git",
              };
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  const remote = {
    provider: "github",
    repository: "owner/repository",
    defaultBranch: "main",
  } as const;
  const drive = yield* TestDrive.pipe(
    Effect.provide(
      Layer.mock(TestDrive, {
        remote: () =>
          Effect.suspend(() => {
            state.remoteReads++;
            return state.driveFailure
              ? Effect.fail(new DriveObjectError({ operation: "remote", cause: "offline" }))
              : Effect.succeed(state.imported ? remote : null);
          }),
        refs: () =>
          Effect.sync(() => ({
            main: state.main,
            thread: null,
            wip: null,
            machine: null,
            base: state.main,
            packs: [],
            remote,
            shallow: [],
          })),
      }),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitHub, { pipesForUser: () => Effect.succeed(null), api: makeGitHubApi(client) }),
    Layer.mock(GitHubConnection, {
      configured: Effect.succeed(true),
      accessToken: Effect.sync(() => state.token),
    }),
    Layer.mock(UserDrives, {
      access: () =>
        Effect.sync(() => {
          state.folderChecks++;
          return state.role;
        }),
    }),
    Layer.mock(CloudThreadService, {
      threadSnapshot: (by, id) =>
        Effect.suspend(() => {
          state.threadChecks++;
          return state.threadVisible && by.userId === actor.userId && id === threadId
            ? Effect.succeed({
                ...snapshot,
                projection: {
                  ...snapshot.projection,
                  thread: {
                    ...snapshot.projection.thread,
                    projectId: state.threadProjectId,
                    branch: state.threadBranch,
                    worktreePath: state.threadPath,
                  },
                },
              })
            : Effect.fail(new ThreadNotFoundError({}));
        }),
    }),
  );
  const directory = Layer.succeed(DriveDirectory, { forDrive: () => drive });
  const make = Effect.gen(function* () {
    const drives = yield* UserDrives;
    const threads = yield* CloudThreadService;
    return yield* makeGitHubRefs({ drive: drives.access, threadSnapshot: threads.threadSnapshot });
  });
  const listRefs = yield* make.pipe(Effect.provide(Layer.merge(dependencies, directory)));
  const withoutDirectory = yield* make.pipe(Effect.provide(dependencies));
  return { state, listRefs, withoutDirectory };
});
