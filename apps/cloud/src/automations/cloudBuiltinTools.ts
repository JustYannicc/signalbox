import {
  AutomationError,
  CommandId,
  MessageId,
  PullRequestMergeMethod,
  ThreadId,
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

import type { PullRequestMerges } from "../github/PullRequestMerges.ts";
import type * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { Actor } from "../thread/ThreadEngine.ts";

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
const threadIdOf = (args: Args) =>
  typeof args.threadId === "string" && args.threadId !== ""
    ? Effect.succeed(ThreadId.make(args.threadId))
    : refuse("Pass threadId: automations have no thread of their own.");

/** A pull request's web URL: host, owner/repo and number. */
const PULL_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const isMergeMethod = Schema.is(PullRequestMergeMethod);

export const makeCloudBuiltinTools = (deps: {
  readonly threads: AutomationThreadsShape;
  readonly service: CloudThreadService.CloudThreadService["Service"];
  readonly owner: Effect.Effect<Actor, AutomationError>;
  readonly merges: PullRequestMerges["Service"];
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
    // The merge gate's evidence, all about one head commit: the server's `pull_request_read`
    // (`apps/server/src/workflows/builtinTools/pullRequestAction.ts`) plus what it can't read.
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
  };

  return {
    tools: Object.keys(tools),
    call: (call) => {
      const tool = tools[call.tool];
      return tool
        ? tool(call, argsOf(call.args))
        : refuse(`signalbox.${call.tool} isn't available in the cloud.`);
    },
  };
};
