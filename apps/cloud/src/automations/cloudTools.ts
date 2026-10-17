import {
  AutomationError,
  ProjectId,
  ThreadId,
  type AutomationDefaults,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { runtimeModeWithin } from "@signalbox/automations/access";
import type { AuthorizeAutomation } from "@signalbox/automations/catalog";
import type { AutomationThreadsShape } from "@signalbox/automations/host";
import { builtInById } from "@signalbox/automations/defaults/registry";
import { builtInReadResult } from "@signalbox/automations/tools/builtIns";
import {
  automationSummary,
  readResult,
  runReadResult,
  runSummary,
  saveResult,
} from "@signalbox/automations/tools/summaries";
import type { WorkflowEngineShape } from "@signalbox/automations/WorkflowEngine";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";

import type { UserFolders } from "../user/UserFolders.ts";
import { acceptCompiled, type CloudCompiler } from "./cloudCompiler.ts";
import { setFolderPhase } from "./folderPhaseTool.ts";

/**
 * Automation tools an agent calls from its cloud thread's machine, answered
 * like the server's MCP handlers (`apps/server/src/workflows/mcp/handlers.ts`)
 * with the same result shapes. The calling thread is the caller: automations
 * it saves or runs act with its model and modes, never more. The machine
 * compiles saves (oxc can't run here) and validates locally.
 */

type Input = Readonly<Record<string, unknown>>;
type Handler = (
  caller: OrchestrationV2ThreadShell,
  input: Input,
) => Effect.Effect<unknown, AutomationError>;

const refuse = (message: string): Effect.Effect<never, AutomationError> =>
  Effect.fail(new AutomationError({ message }));
const text = (input: Input, key: string) =>
  typeof input[key] === "string" && input[key] !== "" ? (input[key] as string) : undefined;
const required = (input: Input, key: string): Effect.Effect<string, AutomationError> => {
  const value = text(input, key);
  return value === undefined ? refuse(`Pass ${key}.`) : Effect.succeed(value);
};

/** What the caller's automations act with: its thread's model and modes. */
const defaultsOf = (caller: OrchestrationV2ThreadShell): AutomationDefaults => ({
  modelSelection: caller.modelSelection,
  runtimeMode: caller.runtimeMode,
  interactionMode: caller.interactionMode,
});

/** Allows only automations that run within the caller's runtime mode. */
const withinCaller =
  (caller: OrchestrationV2ThreadShell): AuthorizeAutomation<AutomationError> =>
  (current) =>
    runtimeModeWithin(current.runtimeMode, caller.runtimeMode)
      ? Effect.void
      : refuse(
          `That automation runs with ${current.runtimeMode} access, more than this thread's ${caller.runtimeMode}.`,
        );

/**
 * A pull request named by its web URL, or by number on a repository the
 * thread links. Hosts and repositories ignore case, and the thread stores
 * links by their normalized key, which is what `pr.*` events carry; so a
 * target is always the thread's own link when it has one, else the key.
 */
const pullRequestTarget = (caller: OrchestrationV2ThreadShell, input: Input) =>
  Effect.gen(function* () {
    const links = caller.pullRequests ?? [];
    const url = text(input, "url");
    if (url) {
      const match = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
      if (!match)
        return yield* refuse(
          "Pass the pull request's web URL, like https://github.com/owner/repo/pull/12.",
        );
      const key = normalizeThreadPullRequestKey({
        host: match[1]!,
        repository: match[2]!,
        number: Number(match[3]),
        url,
      });
      const own = links.find((link) => threadPullRequestKeysEqual(link, key));
      return own
        ? { host: own.host, repository: own.repository, number: own.number, url: own.url }
        : { ...key, url };
    }
    const number = typeof input.number === "number" ? input.number : undefined;
    const repository = text(input, "repository")?.toLowerCase();
    const linked = links.find(
      (link) =>
        (number === undefined || link.number === number) &&
        (repository === undefined || link.repository.toLowerCase() === repository),
    );
    if (!linked)
      return yield* refuse("Pass the pull request's URL, or the number of one this thread links.");
    return {
      host: linked.host,
      repository: linked.repository,
      number: linked.number,
      url: linked.url,
    };
  });

export const makeCloudTools = (deps: {
  readonly engine: WorkflowEngineShape;
  readonly compiler: CloudCompiler["Service"];
  readonly threads: AutomationThreadsShape;
  readonly folders: UserFolders["Service"];
}): Readonly<Record<string, Handler>> => {
  const { engine } = deps;

  const watch =
    (watching: boolean): Handler =>
    (caller, input) =>
      Effect.gen(function* () {
        const target = yield* pullRequestTarget(caller, input);
        const result = yield* engine.watchPullRequest(
          { threadId: caller.id, ...target, watching },
          { authorize: withinCaller(caller), builtInDefaults: defaultsOf(caller) },
        );
        return { ...target, ...result };
      });

  return {
    automation_save: (caller, input) =>
      Effect.gen(function* () {
        const source = yield* required(input, "source");
        if (input.compiled === undefined)
          return yield* refuse(
            "Save from a cloud thread's machine, which compiles the file first.",
          );
        const compiled = yield* acceptCompiled(input.compiled);
        const automationId = text(input, "automationId");
        const saved = yield* deps.compiler.withStaged(
          source,
          compiled,
          engine.save(
            {
              source,
              projectId: ProjectId.make(text(input, "projectId") ?? caller.projectId),
              defaults: defaultsOf(caller),
              ...(automationId ? { automationId } : {}),
              ...(input.draft === true ? { draft: true } : {}),
            },
            withinCaller(caller),
          ),
        );
        return saveResult(saved);
      }),
    automation_list: () =>
      Effect.all([engine.list(), engine.builtIns]).pipe(
        Effect.map(([automations, builtIns]) => ({
          automations: automations.map(automationSummary),
          builtIns,
        })),
      ),
    automation_read: (_caller, input) =>
      Effect.gen(function* () {
        const automationId = yield* required(input, "automationId");
        const builtIn = builtInById(automationId);
        return builtIn
          ? builtInReadResult(builtIn, engine.validate)
          : readResult(yield* engine.get(automationId));
      }),
    automation_run: (caller, input) =>
      Effect.gen(function* () {
        const automationId = yield* required(input, "automationId");
        const attach = input.attach as { readonly threadId: string } | undefined;
        // Where a built-in runs: the attached thread's project, else the one named, else the caller's.
        const place = attach
          ? (yield* deps.threads
              .getThreadShell(ThreadId.make(attach.threadId))
              .pipe(Effect.orElseSucceed(() => null)))?.projectId
          : (text(input, "projectId") ?? caller.projectId);
        const run = yield* engine.startRun({
          automationId,
          input: input.input,
          trigger: "manual",
          authorize: withinCaller(caller),
          attach: input.attach as never,
          projectId: place,
          builtInDefaults: defaultsOf(caller),
        });
        return { run: runSummary(run) };
      }),
    automation_customize: (caller, input) =>
      Effect.gen(function* () {
        const automationId = yield* required(input, "automationId");
        const automation = yield* engine.customize(automationId, {
          projectId: text(input, "projectId") ?? caller.projectId,
          defaults: defaultsOf(caller),
        });
        return { automation: automationSummary(automation) };
      }),
    automation_run_read: (_caller, input) =>
      required(input, "runId").pipe(
        Effect.flatMap((runId) => engine.getRun(runId)),
        Effect.map(runReadResult),
      ),
    automation_set_enabled: (_caller, input) =>
      required(input, "automationId").pipe(
        Effect.flatMap((automationId) => engine.setEnabled(automationId, input.enabled === true)),
        Effect.map((automation) => ({ automation: automationSummary(automation) })),
      ),
    automation_cancel_run: (_caller, input) =>
      required(input, "runId").pipe(
        Effect.flatMap((runId) => engine.cancelRun(runId)),
        Effect.as({}),
      ),
    automation_run_retry: (caller, input) =>
      required(input, "runId").pipe(
        Effect.flatMap((runId) =>
          engine.retryRun({
            runId,
            version: input.version as never,
            authorize: withinCaller(caller),
          }),
        ),
        Effect.map((run) => ({ run: runSummary(run) })),
      ),
    automation_publish: (_caller, input) =>
      required(input, "automationId").pipe(
        Effect.flatMap((automationId) => engine.publish(automationId)),
        Effect.map((automation) => ({ automation: automationSummary(automation) })),
      ),
    automation_discard_draft: (_caller, input) =>
      required(input, "automationId").pipe(
        Effect.flatMap((automationId) => engine.discardDraft(automationId)),
        Effect.map((automation) => ({ automation: automationSummary(automation) })),
      ),
    automation_delete: (_caller, input) =>
      required(input, "automationId").pipe(
        Effect.flatMap((automationId) => engine.remove(automationId)),
        Effect.as({}),
      ),
    automation_emit: (_caller, input) =>
      required(input, "event").pipe(
        Effect.flatMap((event) => engine.emit({ event, payload: input.payload })),
        Effect.map((woke) => ({ woke })),
      ),
    wait_for: (caller, input) =>
      Effect.gen(function* () {
        const until = yield* required(input, "until");
        const started = yield* engine.startWait(
          {
            threadId: caller.id,
            until,
            on: input.on as never,
            where: input.where as never,
            callback: input.callback as never,
            at: input.at as never,
            timeout: input.timeout as never,
            message: input.message as never,
          },
          { authorize: withinCaller(caller), builtInDefaults: defaultsOf(caller) },
        );
        return {
          waitId: started.waitId,
          alreadySatisfied: started.alreadySatisfied,
          callbackUrl: started.callback ? (started.callback.url ?? started.callback.path) : null,
        };
      }),
    list_waits: (caller) => engine.listWaits(caller.id).pipe(Effect.map((waits) => ({ waits }))),
    stop_waiting: (caller, input) =>
      required(input, "waitId").pipe(
        Effect.flatMap((waitId) => engine.stopWait(caller.id, waitId)),
        Effect.map((stopped) => ({ stopped })),
      ),
    watch_pull_request: watch(true),
    unwatch_pull_request: watch(false),
    merge_pull_request: (caller, input) =>
      Effect.gen(function* () {
        const url = yield* required(input, "url");
        return yield* engine.requestMerge(
          {
            threadId: caller.id,
            url,
            note: text(input, "note"),
            askBecause: text(input, "askBecause"),
          },
          { authorize: withinCaller(caller), builtInDefaults: defaultsOf(caller) },
        );
      }),
    set_folder_phase: (caller, input) =>
      setFolderPhase(deps.folders, input, {
        threadId: ThreadId.make(caller.id),
        projectId: caller.projectId,
      }),
  };
};

/** Runs one tool for the thread that called it. */
export const callTool = (
  tools: Readonly<Record<string, Handler>>,
  caller: OrchestrationV2ThreadShell,
  name: string,
  input: unknown,
) => {
  const handler = tools[name];
  if (!handler) return refuse(`There's no automation tool "${name}" in the cloud.`);
  const args =
    input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {};
  return handler(caller, args).pipe(
    Effect.withSpan("CloudAutomations.tool", {
      attributes: {
        "tool.name": name,
        "thread.id": ThreadId.make(caller.id),
        "folder.id": caller.projectId,
      },
    }),
  );
};
