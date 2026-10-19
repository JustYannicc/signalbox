import {
  AutomationError,
  CommandId,
  MessageId,
  PullRequestMergeMethod,
  ThreadId,
  NonNegativeInt,
  TrimmedNonEmptyString,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type {
  BuiltinToolCall,
  BuiltinToolHandler,
} from "@signalbox/automations/builtinTools/runner";
import type { AutomationThreadsShape } from "@signalbox/automations/host";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  GitHubActions,
  WorkflowArtifactInput,
  WorkflowDispatchInput,
  WorkflowReadInput,
} from "../github/GitHubActions.ts";
import type { PullRequestMerges } from "../github/PullRequestMerges.ts";
import {
  HARNESS_RELEASE_RESULT_PATH,
  HARNESS_RELEASE_WORKFLOW_FILE,
} from "@signalbox/automations/defaults/harnessReleasePolicy";
import type { HarnessProvider } from "../harnessReleases/HarnessReleaseLedger.ts";
import type {
  HarnessReleaseLedgerService,
  HarnessReleaseRunSelection,
} from "../harnessReleases/HarnessReleaseLedgerService.ts";
import type * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";
import type { UserFolders } from "../user/UserFolders.ts";
import { setFolderPhase } from "./folderPhaseTool.ts";

/**
 * `w.call("…", "signalbox.<tool>")` in the cloud: the Signalbox tools the
 * built-in automations use, with the server's names and result shapes
 * (`apps/server/src/mcp/toolkits`). Calls act as the object's owner and only
 * on threads they can see.
 */

type Args = Readonly<Record<string, unknown>>;

const refuse = (message: string) => Effect.fail(new AutomationError({ message }));
const argsOf = (args: unknown): Args =>
  args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
const stringOf = (args: Args, key: string) =>
  typeof args[key] === "string" && args[key] !== "" ? args[key] : null;
const stringRecordOf = (value: unknown): Readonly<Record<string, string>> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "string") return null;
    result[key] = field;
  }
  return result;
};
const threadIdOf = (args: Args) =>
  typeof args.threadId === "string" && args.threadId !== ""
    ? Effect.succeed(ThreadId.make(args.threadId))
    : refuse("Pass threadId: automations have no thread of their own.");

/** A pull request's web URL: host, owner/repo and number. */
const PULL_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const isMergeMethod = Schema.is(PullRequestMergeMethod);
const harnessProvider = Schema.Literals([
  "claude-code",
  "agent-sdk",
  "codex",
] satisfies ReadonlyArray<HarnessProvider>);
const harnessRunSelection = Schema.Literals([
  "current",
  "backfill",
] satisfies ReadonlyArray<HarnessReleaseRunSelection>);
const HarnessReleaseLedgerRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("selection"), provider: harnessProvider }),
  Schema.Struct({
    action: Schema.Literal("record"),
    provider: harnessProvider,
    version: TrimmedNonEmptyString,
    selection: harnessRunSelection,
    runKey: TrimmedNonEmptyString,
    headSha: TrimmedNonEmptyString,
    workflowFile: Schema.Literal(HARNESS_RELEASE_WORKFLOW_FILE),
    workflowRunId: TrimmedNonEmptyString,
    artifactName: TrimmedNonEmptyString,
    entryPath: Schema.Literal(HARNESS_RELEASE_RESULT_PATH),
  }),
  Schema.Struct({
    action: Schema.Literal("promote"),
    provider: harnessProvider,
    releaseId: TrimmedNonEmptyString,
    expectedRevision: NonNegativeInt,
    changedAt: TrimmedNonEmptyString,
  }),
]);
const decodeHarnessReleaseLedgerRequest = Schema.decodeUnknownEffect(HarnessReleaseLedgerRequest);

export const makeCloudBuiltinTools = (deps: {
  readonly threads: AutomationThreadsShape;
  readonly service: CloudThreadService.CloudThreadService["Service"];
  readonly owner: Effect.Effect<Actor, AutomationError>;
  readonly merges: PullRequestMerges["Service"];
  readonly github: GitHubActions["Service"];
  readonly folders: UserFolders["Service"];
  readonly harnessReleaseLedger: HarnessReleaseLedgerService["Service"];
}): BuiltinToolHandler => {
  const shellOf = (threadId: ThreadId) =>
    deps.threads
      .getThreadShell(threadId)
      .pipe(
        Effect.flatMap((shell) =>
          shell === null ? refuse(`There's no thread ${threadId}.`) : Effect.succeed(shell),
        ),
      );

  /** The pull request at `args.url`, as linked to the thread; unlinked or dismissed ones are refused. */
  const linkedPullRequest = (args: Args) =>
    Effect.gen(function* () {
      const threadId = yield* threadIdOf(args);
      const url = typeof args.url === "string" ? args.url : "";
      const target = parseChangeRequestUrl(url);
      if (target === null) return yield* refuse(`"${url}" isn't a pull request URL.`);
      const shell = yield* shellOf(threadId);
      const linked = visibleThreadPullRequests(shell.pullRequests ?? []).find((link) =>
        threadPullRequestKeysEqual(link, target),
      );
      if (!linked)
        return yield* refuse(
          `${url} isn't linked to this thread. Link it with link_pull_request first.`,
        );
      return { host: linked.host, repository: linked.repository, number: linked.number };
    });
  const hostFailure = (what: string) => (cause: { readonly message: string }) =>
    new AutomationError({ message: `${what}: ${cause.message}`, cause });

  const listed = (shell: OrchestrationV2ThreadShell) => ({
    pullRequests: visibleThreadPullRequests(shell.pullRequests ?? []).map((link) => ({
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
      source: link.source,
      watching: link.watch !== null && link.watch !== undefined,
      state: link.snapshot?.state ?? null,
      title: link.snapshot?.title ?? null,
      headBranch: link.snapshot?.headBranch ?? null,
      baseBranch: link.snapshot?.baseBranch ?? null,
      isDraft: link.snapshot?.isDraft ?? null,
      stack: null,
    })),
    chains: [],
  });

  const tools: Record<
    string,
    (call: BuiltinToolCall, args: Args) => Effect.Effect<unknown, AutomationError>
  > = {
    list_thread_pull_requests: (_call, args) =>
      threadIdOf(args).pipe(Effect.flatMap(shellOf), Effect.map(listed)),
    link_pull_request: (call, args) =>
      Effect.gen(function* () {
        const threadId = yield* threadIdOf(args);
        const url = typeof args.url === "string" ? args.url : "";
        const match = PULL_URL.exec(url);
        if (!match)
          return yield* refuse(
            "Pass the pull request's web URL, like https://github.com/owner/repo/pull/12.",
          );
        const target = { host: match[1]!, repository: match[2]!, number: Number(match[3]), url };
        const shell = yield* shellOf(threadId);
        const alreadyLinked = (shell.pullRequests ?? []).some((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (!alreadyLinked)
          yield* deps.owner.pipe(
            Effect.flatMap((actor) =>
              deps.service.dispatchCommand(actor, {
                type: "thread.pull-request.link",
                commandId: CommandId.make(`automation:${call.requestKey}:link`),
                threadId,
                ...target,
                source: "agent",
              }),
            ),
            Effect.mapError(
              (cause) =>
                new AutomationError({ message: `Couldn't link it: ${cause.message}`, cause }),
            ),
          );
        return { ...target, alreadyLinked };
      }),
    // The merge gate judges evidence for one head commit.
    pull_request_read: (_call, args) =>
      Effect.gen(function* () {
        const ref = yield* linkedPullRequest(args);
        const { checks, ...evidence } = yield* deps.merges
          .evidence(ref)
          .pipe(Effect.mapError(hostFailure("Couldn't read the pull request")));
        return {
          repository: ref.repository,
          number: ref.number,
          ...evidence,
          checks:
            checks?.map((check) => ({
              name: check.name,
              status: check.status,
              url: check.url,
              required: check.required ?? null,
            })) ?? null,
        };
      }),
    // Merge and delete-branch, the two the merge gate takes; only automations a person or
    // Signalbox stands behind reach it (`VOUCHED_TOOLS`).
    pull_request_action: (_call, args) =>
      Effect.gen(function* () {
        const ref = yield* linkedPullRequest(args);
        const expectedHeadSha =
          typeof args.expectedHeadSha === "string" ? args.expectedHeadSha : undefined;
        if (args.mergeMethod !== undefined && !isMergeMethod(args.mergeMethod))
          return yield* refuse("mergeMethod is merge, squash or rebase.");
        if (args.action === "merge") {
          const merged = yield* Effect.result(
            deps.merges.merge(ref, {
              ...(expectedHeadSha === undefined ? {} : { headSha: expectedHeadSha }),
              ...(args.mergeMethod === undefined ? {} : { method: args.mergeMethod }),
            }),
          );
          if (merged._tag === "Success")
            return merged.success._tag === "merged"
              ? { state: "merged", moved: false }
              : { state: "open", moved: true };
          // A merge step that runs again after it worked finds it merged already.
          const after = yield* Effect.option(deps.merges.state(ref));
          if (Option.getOrUndefined(after) === "merged") return { state: "merged", moved: false };
          return yield* hostFailure("The host refused to merge it")(merged.failure);
        }
        if (args.action === "delete-branch") {
          yield* deps.merges
            .deleteBranch(ref)
            .pipe(Effect.mapError(hostFailure("The host didn't delete its branch")));
          const after = yield* Effect.option(deps.merges.state(ref));
          return { state: Option.getOrElse(after, () => "merged" as const), moved: false };
        }
        return yield* refuse(
          `pull_request_action "${String(args.action)}" isn't available in the cloud yet; merge and delete-branch are.`,
        );
      }),
    // The folder named, else the home of the thread passed (#677).
    set_folder_phase: (_call, args) =>
      Effect.gen(function* () {
        // A named folder needs no thread.
        const named = typeof args.folderId === "string" && args.folderId !== "";
        const shell =
          named || args.threadId === undefined
            ? null
            : yield* threadIdOf(args).pipe(Effect.flatMap(shellOf));
        return yield* setFolderPhase(
          deps.folders,
          args,
          shell === null ? null : { threadId: shell.id, projectId: shell.projectId },
        );
      }),
    t3_thread_send: (call, args) =>
      Effect.gen(function* () {
        const threadId = yield* threadIdOf(args);
        const text = typeof args.message === "string" ? args.message : "";
        if (!text.trim()) return yield* refuse("Pass the message to send.");
        const shell = yield* shellOf(threadId);
        const base = `automation:${call.requestKey}:send`;
        yield* deps.threads.send({
          projectId: shell.projectId,
          commandId: CommandId.make(base),
          threadId,
          messageId: MessageId.make(`${base}:message`),
          text,
          attachments: [],
          createdBy: "system",
          creationSource: "server",
        });
        return { threadId, delivery: "queued" };
      }),
    harness_release_ledger: (call, args) =>
      Effect.gen(function* () {
        const request = yield* decodeHarnessReleaseLedgerRequest(args).pipe(
          Effect.mapError(
            (cause) =>
              new AutomationError({
                message: "The harness release ledger request is invalid.",
                cause,
              }),
          ),
        );
        if (request.action === "selection")
          return yield* deps.harnessReleaseLedger.selection(call.projectId, request.provider);
        if (request.action === "promote") {
          const { action: _action, ...input } = request;
          return yield* deps.harnessReleaseLedger.promote(call.projectId, input);
        }
        const { action: _action, ...input } = request;
        return yield* deps.harnessReleaseLedger.record(call.projectId, input);
      }),
    github_workflow: (call, args) =>
      Effect.gen(function* () {
        const action = stringOf(args, "action");
        const workflowFile = stringOf(args, "workflowFile");
        const headSha = stringOf(args, "headSha");
        if (workflowFile === null || headSha === null)
          return yield* refuse("Pass workflowFile and headSha.");
        if (action === "dispatch") {
          const ref = stringOf(args, "ref");
          const correlationId = stringOf(args, "correlationId");
          const inputs = stringRecordOf(args.inputs);
          if (ref === null || correlationId === null || inputs === null)
            return yield* refuse("Dispatch needs ref, correlationId and string inputs.");
          const request: WorkflowDispatchInput = {
            workflowFile,
            ref,
            headSha,
            correlationId,
            inputs,
          };
          return yield* deps.github.workflowDispatch(call.projectId, request);
        }
        const runId = stringOf(args, "runId");
        if (runId === null) return yield* refuse("Pass runId.");
        if (action === "read") {
          const request: WorkflowReadInput = { workflowFile, runId, headSha };
          return yield* deps.github.workflowRead(call.projectId, request);
        }
        if (action === "artifact") {
          const artifactName = stringOf(args, "artifactName");
          const entryPath = stringOf(args, "entryPath");
          if (artifactName === null || entryPath === null)
            return yield* refuse("Artifact reads need artifactName and entryPath.");
          const request: WorkflowArtifactInput = {
            workflowFile,
            runId,
            headSha,
            artifactName,
            entryPath,
          };
          return yield* deps.github.workflowArtifact(call.projectId, request);
        }
        return yield* refuse("github_workflow action is dispatch, read or artifact.");
      }),
    github_issue: (call, args) =>
      Effect.gen(function* () {
        if (args.action !== "create") return yield* refuse("github_issue action is create.");
        const title = stringOf(args, "title");
        const body = stringOf(args, "body");
        const correlationId = stringOf(args, "correlationId");
        if (title === null || body === null || correlationId === null)
          return yield* refuse("Issue creation needs title, body and correlationId.");
        return yield* deps.github.createIssue(call.projectId, { title, body, correlationId });
      }),
  };

  return {
    tools: Object.keys(tools),
    policies: {
      pull_request_action: { requiresVouch: true, projectScope: "thread" },
      harness_release_ledger: { requiresVouch: true, projectScope: "run" },
      github_workflow: { requiresVouch: true, projectScope: "run" },
      github_issue: { requiresVouch: true, projectScope: "run" },
    },
    call: (call) => {
      const tool = tools[call.tool];
      return tool
        ? tool(call, argsOf(call.args))
        : refuse(`signalbox.${call.tool} isn't available in the cloud.`);
    },
  };
};
