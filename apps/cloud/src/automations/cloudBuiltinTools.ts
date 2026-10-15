import {
  AutomationError,
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type {
  BuiltinToolCall,
  BuiltinToolHandler,
} from "@signalbox/automations/builtinTools/runner";
import type { AutomationThreadsShape } from "@signalbox/automations/host";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";

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

export const makeCloudBuiltinTools = (deps: {
  readonly threads: AutomationThreadsShape;
  readonly service: CloudThreadService.CloudThreadService["Service"];
  readonly owner: Effect.Effect<Actor, AutomationError>;
}): BuiltinToolHandler => {
  const shellOf = (threadId: ThreadId) =>
    deps.threads
      .getThreadShell(threadId)
      .pipe(
        Effect.flatMap((shell) =>
          shell === null ? refuse(`There's no thread ${threadId}.`) : Effect.succeed(shell),
        ),
      );

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
