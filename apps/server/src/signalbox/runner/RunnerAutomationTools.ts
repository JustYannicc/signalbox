import { AUTOMATION_TOOLS } from "@signalbox/automations/tools/declarations";
import { validateResult } from "@signalbox/automations/tools/summaries";
import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import { compileWorkflow } from "../../workflows/compiler/compileWorkflow.ts";
import { skillReference, unknownTopic } from "../../workflows/skill/files.ts";
import type { ContextClient } from "./RunnerContextClient.ts";
import { badArguments, fail, register, ToolError } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

/**
 * The automation tools (#434) on the context server, declared as on a
 * self-hosted server (`@signalbox/automations/tools/declarations`), for agents
 * whose automations run in the cloud. Every call goes to the thread's owner's
 * engine with the turn's drive token, which names the thread
 * (`AutomationProtocol.ts`), and answers the JSON the server's tool would.
 *
 * Compiling needs Node, so it happens here: `automation_validate` answers
 * without the cloud, and `automation_save` sends its `CompiledWorkflow` as
 * `compiled` beside the input. `automation_reference` reads the skill bundled
 * with the Runner. `watch_pull_request` and `unwatch_pull_request` take
 * upstream's input and start or stop the "Watch pull request" built-in there.
 */

/**
 * Tools the cloud's engine answers as the agent calls them
 * (`apps/cloud/src/automations/cloudTools.ts`). `automation_set_webhook_secret`
 * stays off until the cloud takes secrets from `request_secret`.
 */
const FORWARDED = [
  "automation_list",
  "automation_read",
  "automation_publish",
  "automation_discard_draft",
  "automation_set_enabled",
  "automation_delete",
  "automation_customize",
  "automation_run",
  "automation_run_read",
  "automation_run_retry",
  "automation_cancel_run",
  "automation_emit",
  "wait_for",
  "list_waits",
  "stop_waiting",
] as const;

/**
 * Upstream's pull request target (`mcp/toolkits/pullRequests/tools.ts`), which
 * the Runner can't import without the whole server; RunnerAutomationTools.test.ts
 * keeps it and the descriptions equal to upstream's.
 */
export const PullRequestTargetInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread to act on. Omit for this thread.",
    }),
  ),
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The pull request's web URL, for example https://github.com/owner/repo/pull/123. Preferred when you have it; host, repository and number are read from it.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Repository path below the host, for example owner/repo. Required with number when url is omitted.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "Pull request number. Required with repository when url is omitted.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Host the repository lives on, for example github.com. Defaults to the host of this thread's project.",
    }),
  ),
});

const PULL_REQUEST_WATCH_TOOLS = {
  watch_pull_request: {
    description:
      "Have Signalbox watch an open pull request for this thread, linking it first if needed. Signalbox checks it every two minutes and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to monitor or babysit a pull request instead of polling, sleeping, or running a watcher. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision: check readiness yourself before merging. While Signalbox watches, the thread stays in the user's Working list, not their inbox. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox. Watching ends when the pull request merges or closes, when its thread settles or is archived, when Signalbox fails to read it 8 times in a row (a host rate limit only delays it), when the user stops this thread, or when you call unwatch_pull_request. Unsettle the thread before starting a new watch. A subagent cannot watch: its parent thread owns the pull request.",
  },
  unwatch_pull_request: {
    description:
      "Stop Signalbox from watching a pull request for this thread. The pull request stays linked. Pass the URL, or repository plus number.",
  },
} as const;

/** Every tool this serves, by name. */
export const RUNNER_AUTOMATION_TOOLS: ReadonlyArray<string> = [
  "automation_reference",
  "automation_validate",
  "automation_save",
  ...FORWARDED,
  ...Object.keys(PULL_REQUEST_WATCH_TOOLS),
];

/** A tool's input schema: a plain struct, which decodes and encodes without services. */
type Input = Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never };

/** A declaration as the Runner serves it, from the package's or upstream's. */
interface Declared<S extends Input> {
  readonly description: string;
  /** Absent for a tool without inputs, which MCP still declares as an empty object. */
  readonly parameters?: S;
  readonly readonly: boolean;
  readonly destructive?: boolean;
}

/** The MCP side of a declaration: its name, description, input and what it writes. */
const mcp = <S extends Input>(
  name: string,
  declaration: Declared<S> & { readonly parameters: S },
) => ({
  name,
  description: declaration.description,
  parameters: declaration.parameters,
  ...(declaration.readonly
    ? {}
    : { writes: { destructive: declaration.destructive ?? false, openWorld: false } }),
});

/** Answers the way the server's MCP tools do: the result as JSON text. */
const answer = (result: unknown) => (result === undefined ? "" : JSON.stringify(result));

/** The automation tools, reaching the cloud through `view`'s client. */
export const layerAutomationTools = (view: DrivesView) => {
  const client = Effect.suspend((): Effect.Effect<ContextClient, ToolError> => {
    const current = view.client();
    return current === null
      ? fail("Automations open with the thread's first turn.")
      : Effect.succeed(current);
  });

  /** Asks the cloud's engine; only a read is retried, so a write never happens twice. */
  const call = (name: string, input: unknown, retry: boolean) =>
    Effect.gen(function* () {
      const result = yield* (yield* client).automationTool({ name, input }, { retry }).pipe(
        Effect.mapError(
          (error) =>
            new ToolError({
              message:
                error.status === undefined
                  ? "Signalbox's cloud didn't answer, so this may not have happened. Check with automation_list or list_waits before trying again."
                  : error.message,
            }),
        ),
      );
      if (result._tag === "failed") return yield* fail(result.message);
      return answer(result.result);
    });

  /** Serves a tool the cloud answers, with the input encoded back to what the agent sent. */
  const forward = (name: string, declaration: Declared<Input>) => {
    const parameters = declaration.parameters ?? Tool.EmptyParams;
    const encode = Schema.encodeUnknownEffect(parameters);
    return register({
      ...mcp(name, { ...declaration, parameters }),
      handle: (input) =>
        encode(input).pipe(
          Effect.mapError(badArguments),
          Effect.flatMap((encoded) => call(name, encoded, declaration.readonly)),
        ),
    });
  };

  const tools = AUTOMATION_TOOLS;
  const encodeSave = Schema.encodeEffect(tools.automation_save.parameters);
  return Layer.effectDiscard(
    Effect.all([
      ...FORWARDED.map((name) => forward(name, tools[name])),
      ...Object.entries(PULL_REQUEST_WATCH_TOOLS).map(([name, { description }]) =>
        forward(name, { description, parameters: PullRequestTargetInput, readonly: false }),
      ),
      register({
        ...mcp("automation_reference", tools.automation_reference),
        handle: ({ topic }) => {
          const reference = skillReference(topic);
          return reference === null
            ? fail(unknownTopic(topic ?? ""))
            : Effect.succeed(answer({ reference }));
        },
      }),
      register({
        ...mcp("automation_validate", tools.automation_validate),
        handle: ({ source }) =>
          Effect.sync(() => {
            const compiled = compileWorkflow(source);
            return answer(
              validateResult(
                compiled.ok
                  ? { ok: true, graph: compiled.workflow.graph }
                  : { ok: false, diagnostics: compiled.diagnostics },
              ),
            );
          }),
      }),
      register({
        ...mcp("automation_save", tools.automation_save),
        handle: (input) =>
          Effect.gen(function* () {
            const compiled = compileWorkflow(input.source);
            // What the server's save answers for a file that doesn't compile.
            if (!compiled.ok) return answer({ ok: false, diagnostics: compiled.diagnostics });
            const encoded = yield* encodeSave(input).pipe(Effect.mapError(badArguments));
            return yield* call(
              "automation_save",
              { ...encoded, compiled: compiled.workflow },
              false,
            );
          }),
      }),
    ]),
  );
};
