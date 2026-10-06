import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AutomationDefaults,
  type ModelSelection,
  type ProviderOptionSelection,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Stream from "effect/Stream";

import { subagentResultForRun } from "../orchestration-v2/SubagentProjection.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  isTerminalRunStatus,
  latestRun,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import { automationError, errorMessage, fail, isAutomationError } from "./errors.ts";
import { asRecord, jsonOrText } from "./json.ts";
import { explained } from "./runLog.ts";
import { describeDuration, durationMs, TransientFailure } from "./stepPolicy.ts";
import type { StepRow } from "./WorkflowStore.ts";

/** How a step got going: done already, or waiting on something outside the run. */
export type StepStart =
  | { readonly type: "done"; readonly value: unknown }
  | {
      readonly type: "waiting";
      readonly threadId?: string;
      /** The run to wait for when the step continued an existing thread. */
      readonly agentRunId?: string;
      readonly wakeAt?: string;
      readonly event?: string;
    };

/** When a `sleep` or `waitFor` timeout ends: `{ minutes: 5 }`-style durations add up; `until` is an ISO time. */
export const wakeAt = (options: unknown) =>
  Effect.gen(function* () {
    const value = asRecord(options);
    if (typeof value.until === "string") {
      const until = DateTime.make(value.until);
      if (Option.isNone(until)) return yield* fail(`"${value.until}" isn't a time I can read.`);
      return DateTime.formatIso(until.value);
    }
    const total = durationMs(value);
    if (total === null)
      return yield* fail("A duration needs seconds, minutes, hours, days or until.");
    return yield* afterMs(total);
  });

/** Now plus `ms`, as stored in `wake_at`. */
export const afterMs = (ms: number) =>
  DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.add(now, { milliseconds: ms }))),
  );

/** The deterministic launch ids for an agent step, so a retried launch finds the same thread. */
function agentLaunchIds(step: Pick<StepRow, "run_id" | "step_key" | "attempt">) {
  const first = `automation:${step.run_id}:${step.step_key}`;
  // Each retry gets a thread of its own; the first attempt keeps the ids older runs used.
  const base = step.attempt > 1 ? `${first}:attempt-${step.attempt}` : first;
  return { commandId: CommandId.make(base), messageId: MessageId.make(`${base}:message`) };
}

/** `worktree: "main"`, or `{ base, branch?, fromOrigin? }` to name the branch and start from the remote. */
function workspaceFor(worktree: unknown) {
  if (typeof worktree === "string" && worktree.trim()) {
    return { type: "worktree" as const, baseRef: worktree.trim() };
  }
  const options = asRecord(worktree);
  if (typeof options.base !== "string" || !options.base.trim()) return { type: "root" as const };
  return {
    type: "worktree" as const,
    baseRef: options.base.trim(),
    ...(typeof options.branch === "string" && options.branch.trim()
      ? { branch: options.branch.trim() }
      : {}),
    startFromOrigin: options.fromOrigin !== false,
  };
}

/**
 * The model's own reasoning-effort option, from the live provider catalog:
 * Claude calls it `effort`, Codex `reasoningEffort`. Null when the model has
 * none; without a catalog (tests) it's `effort` with any value.
 */
const effortOption = (instanceId: string, model: string) =>
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    if (Option.isNone(registry)) return { id: "effort", values: null };
    const providers = yield* registry.value.getProviders;
    const descriptors =
      providers
        .find((provider) => provider.instanceId === instanceId)
        ?.models.find((candidate) => candidate.slug === model)?.capabilities?.optionDescriptors ??
      [];
    const descriptor = descriptors.find(
      (candidate) => candidate.type === "select" && /effort/i.test(candidate.id),
    );
    if (descriptor?.type !== "select") return null;
    return { id: descriptor.id, values: descriptor.options.map((option) => option.id) };
  });

/** The defaults' model, with `provider`, `model` and `effort` from the step's options applied. */
const modelFor = (options: Readonly<Record<string, unknown>>, defaults: AutomationDefaults) =>
  Effect.gen(function* () {
    const provider = typeof options.provider === "string" ? options.provider : undefined;
    const model = typeof options.model === "string" ? options.model : undefined;
    const effort = typeof options.effort === "string" ? options.effort : undefined;
    const switched = provider !== undefined && provider !== defaults.modelSelection.instanceId;
    if (switched && !model) {
      return yield* fail(
        `Name the model to use with ${provider}: { provider: "${provider}", model: "…" }.`,
      );
    }
    let selections: ReadonlyArray<ProviderOptionSelection> = switched
      ? []
      : (defaults.modelSelection.options ?? []);
    if (effort) {
      const instanceId = provider ?? defaults.modelSelection.instanceId;
      const modelSlug = model ?? defaults.modelSelection.model;
      const option = yield* effortOption(instanceId, modelSlug);
      if (option === null) {
        return yield* fail(`${modelSlug} on ${instanceId} has no reasoning effort to set.`);
      }
      if (option.values && !option.values.includes(effort)) {
        return yield* fail(
          `${modelSlug} doesn't have effort "${effort}". Use one of: ${option.values.join(", ")}.`,
        );
      }
      selections = [
        ...selections.filter((selection) => !/effort/i.test(selection.id)),
        { id: option.id, value: effort },
      ];
    }
    const { options: _inherited, ...base } = defaults.modelSelection;
    const selection: ModelSelection = {
      ...base,
      ...(provider ? { instanceId: ProviderInstanceId.make(provider) } : {}),
      ...(model ? { model } : {}),
      ...(selections.length > 0 ? { options: selections } : {}),
    };
    return selection;
  });

/**
 * Starts the thread for an `agent` step, or for a model step with its built
 * `prompt` in plan mode. `thread: id` sends the prompt to an existing thread
 * in the project instead, queued behind any turn it's running. The step
 * finishes when that thread's run ends.
 */
export const launchAgent = (input: {
  readonly step: StepRow;
  readonly options: unknown;
  readonly projectId: string;
  readonly defaults: AutomationDefaults;
  readonly prompt?: string;
  readonly interactionMode?: ProviderInteractionMode;
  /** How long the thread may run before the step fails; the tick enforces it. */
  readonly timeoutMs: number | null;
}) =>
  Effect.gen(function* () {
    const options = asRecord(input.options);
    const prompt = input.prompt ?? options.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return yield* fail("An agent step needs a prompt.");
    }
    const modelSelection = yield* modelFor(options, input.defaults);
    const { commandId, messageId } = agentLaunchIds(input.step);
    const deadline = input.timeoutMs === null ? undefined : yield* afterMs(input.timeoutMs);
    const until = deadline ? { wakeAt: deadline } : {};

    if (typeof options.thread === "string" && options.thread.trim()) {
      const threadId = ThreadId.make(options.thread.trim());
      const threads = yield* ThreadManagementService;
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null) {
        return yield* fail(`There's no thread ${threadId} to continue.`);
      }
      if (shell.projectId !== input.projectId) {
        return yield* fail("An agent step can only continue threads in this automation's project.");
      }
      const switched =
        typeof options.provider === "string" ||
        typeof options.model === "string" ||
        typeof options.effort === "string";
      const sent = yield* threads
        .sendToThread({
          projectId: shell.projectId,
          commandId,
          threadId,
          messageId,
          text: prompt,
          attachments: [],
          ...(switched ? { modelSelection } : {}),
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            automationError(`Couldn't send to the agent's thread: ${cause.message}`, { cause }),
          ),
        );
      return {
        type: "waiting",
        threadId,
        agentRunId: sent.run.id,
        ...until,
      } satisfies StepStart;
    }

    const launch = yield* ThreadLaunchService;
    const launched = yield* launch
      .launch({
        commandId,
        projectId: ProjectId.make(input.projectId),
        title: input.step.label,
        generateTitle: false,
        modelSelection,
        runtimeMode: input.defaults.runtimeMode,
        interactionMode: input.interactionMode ?? input.defaults.interactionMode,
        workspaceStrategy: workspaceFor(options.worktree),
        initialMessage: { messageId, text: prompt, attachments: [] },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError((cause) =>
          automationError(`Couldn't start the agent: ${cause.message}`, { cause }),
        ),
      );
    return { type: "waiting", threadId: launched.threadId, ...until } satisfies StepStart;
  });

/**
 * Reads an agent step's thread: its latest run, or `runId` when the step
 * continued a thread. Returns undefined while that run is still going, else
 * the final message with where the work lives (branch, worktree, pull
 * request), or the error when the run didn't complete.
 */
export const agentResult = (threadId: string, runId?: string | null) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const id = ThreadId.make(threadId);
    const shell = yield* threads.getThreadShell(id);
    if (shell === null || shell.deletedAt !== null) {
      return {
        ok: false,
        error: "The agent's thread was deleted.",
        detail: {
          why: "Someone deleted the agent's thread while the step waited on it.",
          fix: "Run the automation again.",
          link: null,
        },
      } as const;
    }
    const { runs } = yield* threads.getThreadRecords(id, ["runs"]);
    const run = runId ? runs.find((candidate) => candidate.id === runId) : latestRun({ runs });
    if (!run || !isTerminalRunStatus(run.status)) return undefined;
    const records = yield* threads.getThreadRecords(id, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunId: run.id,
      turnItemTypes: ["assistant_message", "error"],
    });
    const { text } = subagentResultForRun(records, run);
    const pullRequest = shell.branchPullRequest ?? shell.linkedPullRequest ?? null;
    return run.status === "completed"
      ? ({
          ok: true,
          value: {
            text,
            threadId,
            branch: shell.branch,
            worktreePath: shell.worktreePath,
            pullRequest: pullRequest && { number: pullRequest.number, url: pullRequest.url },
          },
        } as const)
      : ({ ok: false, error: text || `The agent's run ended as ${run.status}.` } as const);
  }).pipe(
    Effect.mapError((cause) => automationError("Couldn't read the agent's thread.", { cause })),
  );

const HTTP_MAX_BYTES = 5 * 1024 * 1024;
/** The methods `w.http` sends; TRACE is left out since fetch refuses it. */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const isHttpStepMethod = (method: string): method is (typeof HTTP_METHODS)[number] =>
  (HTTP_METHODS as ReadonlyArray<string>).includes(method);

export interface HttpStepResult {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * `w.http(label, url | { url, method, headers, body, timeout })`. Any status is
 * a result; failing to connect, timing out, or a body over 5 MB fails. Sends
 * `Idempotency-Key` unless the code set one, so a request repeated after a
 * restart or retry can be recognized by servers that support it.
 */
export const httpRequest = (
  request: unknown,
  context: { readonly idempotencyKey: string; readonly timeoutMs: number },
) =>
  Effect.gen(function* () {
    const options = typeof request === "string" ? { url: request } : asRecord(request);
    if (typeof options.url !== "string") return yield* fail("w.http needs a URL.");
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    if (!isHttpStepMethod(method)) {
      return yield* explained(`w.http can't send a ${method} request.`, {
        fix: `Use one of: ${HTTP_METHODS.join(", ")}.`,
      });
    }
    const headers = Object.fromEntries(
      Object.entries(asRecord(options.headers)).map(([name, value]) => [name, String(value)]),
    );
    const hasKey = Object.keys(headers).some((name) => name.toLowerCase() === "idempotency-key");
    let outgoing = HttpClientRequest.make(method)(options.url).pipe(
      HttpClientRequest.setHeaders(
        hasKey ? headers : { ...headers, "idempotency-key": context.idempotencyKey },
      ),
    );
    if (options.body !== undefined) {
      outgoing =
        typeof options.body === "string"
          ? HttpClientRequest.bodyText(outgoing, options.body)
          : HttpClientRequest.bodyJsonUnsafe(outgoing, options.body);
    }
    const client = yield* HttpClient.HttpClient;
    const url = options.url;
    const response = yield* client.execute(outgoing).pipe(
      Effect.timeoutOrElse({
        duration: context.timeoutMs,
        orElse: () =>
          Effect.fail(
            transient(`${url} didn't answer within ${describeDuration(context.timeoutMs)}.`, {
              fix: "Give the step more time, e.g. { timeout: { minutes: 5 } }, or check that the service is up.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : transient(`The request failed: ${errorMessage(cause)}`, { cause }),
      ),
    );
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > HTTP_MAX_BYTES) return yield* tooLarge(url);
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(response.stream, (chunk) => {
      size += chunk.byteLength;
      if (size > HTTP_MAX_BYTES) return tooLarge(url);
      chunks.push(chunk);
      return Effect.void;
    }).pipe(
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : transient(`Couldn't read the response: ${errorMessage(cause)}`, { cause }),
      ),
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    const body = (response.headers["content-type"] ?? "").includes("json")
      ? jsonOrText(text)
      : text;
    return {
      status: response.status,
      ok: response.status < 400,
      headers: response.headers,
      body,
    } satisfies HttpStepResult;
  });

/** Statuses worth asking again for: the server was busy or broken, not the request. */
export const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/** A failure worth retrying: the network or a timeout. */
const transient = (message: string, help: { readonly cause?: unknown; readonly fix?: string }) =>
  explained(message, {
    ...(help.fix ? { fix: help.fix } : {}),
    cause: new TransientFailure(message, { cause: help.cause }),
  });

const tooLarge = (url: string) =>
  Effect.fail(
    explained(`The response from ${url} is over ${HTTP_MAX_BYTES / 1024 / 1024} MB.`, {
      fix: "Ask the API for less, with paging or filters, or fetch it inside a w.run function.",
    }),
  );
