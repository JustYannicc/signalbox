import { CODEX_DRIVER_KIND } from "@signalbox/provider-codex/defaults";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeCodexIsolateAdapter, type CodexIsolateAdapterOptions } from "./CodexIsolateAdapter.ts";
import { HarnessError, type HarnessOpenInput } from "./Harness.ts";
import type {
  NativeHostBinding,
  NativeMcpConfiguration,
  NativeThreadLoad,
} from "./HarnessSessionHost.ts";
import type { HarnessOwnedProcess } from "./HarnessProcessLifetime.ts";
import { mcpAborted } from "./host/mcp.ts";

type NativeRuntime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
export interface CodexNativeHostBindingOptions extends Omit<CodexIsolateAdapterOptions, "adapter"> {
  readonly adapter: Omit<CodexIsolateAdapterOptions["adapter"], "mcpServers">;
}

const loadKey = (load: NativeThreadLoad) => {
  const requested =
    load.method === "ensureThread" ? load.input.existingProviderThread : load.input.providerThread;
  return stableStringify({
    method: load.method,
    threadId: load.input.threadId ?? requested?.appThreadId,
    providerSessionId:
      load.method === "ensureThread"
        ? (load.input.providerSessionId ?? requested?.providerSessionId)
        : requested?.providerSessionId,
    modelSelection: load.input.modelSelection,
    runtimePolicy: load.input.runtimePolicy,
    thread:
      requested === undefined
        ? undefined
        : {
            id: requested.id,
            driver: requested.driver,
            providerSessionId: requested.providerSessionId,
            providerInstanceId: requested.providerInstanceId,
            appThreadId: requested.appThreadId,
            nativeThreadRef: requested.nativeThreadRef,
          },
  });
};

type McpInstallation = {
  readonly key: string;
  readonly settings: string;
  readonly thread: OrchestrationV2ProviderThread;
};

type McpAttempt = {
  readonly configuration: NativeMcpConfiguration;
  readonly signal: AbortSignal;
  // AdapterHarness needs the first setup handed off; later turns may already have this thread loaded.
  readonly handoffRequired: boolean;
  servers: NativeMcpConfiguration["servers"];
  phase: "configuring" | "ready" | "started" | "completed" | "failed";
  mapReads: number;
  installed: McpInstallation | undefined;
  handedOff: boolean;
};

/** Each native turn consumes one grant-scoped MCP map and one thread load. */
export function makeCodexNativeHostBinding(
  options: CodexNativeHostBindingOptions,
): NativeHostBinding {
  let native: NativeRuntime | undefined;
  let process: HarnessOwnedProcess | undefined;
  let harness: HarnessOpenInput | undefined;
  let current: McpAttempt | undefined;
  const unavailableInstallation = () =>
    new HarnessError({
      operation: "turn",
      message: "Codex MCP installation is unavailable.",
    });
  const unavailable = (cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CODEX_DRIVER_KIND,
      detail: "Codex thread does not match the installed MCP binding.",
      cause,
    });
  const factory = makeCodexIsolateAdapter({
    ...options,
    processObserver: {
      started(value) {
        process = value;
        options.processObserver?.started(value);
      },
      abandoned(cause) {
        options.processObserver?.abandoned(cause);
      },
    },
    adapter: {
      ...options.adapter,
      mcpServers: () =>
        Effect.try({
          try: () => {
            const attempt = current;
            if (attempt === undefined || attempt.phase !== "configuring")
              throw new Error("Codex MCP map is not installed.");
            attempt.signal.throwIfAborted();
            if (++attempt.mapReads !== 1) throw new Error("Codex MCP map was already consumed.");
            return attempt.servers;
          },
          catch: (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Codex MCP map is unavailable.",
              cause,
            }),
        }),
    },
  });
  const handoff = (load: NativeThreadLoad) =>
    Effect.gen(function* () {
      const attempt = current;
      const ready = attempt?.installed;
      const key = yield* Effect.try({ try: () => loadKey(load), catch: unavailable });
      if (
        attempt === undefined ||
        attempt.phase !== "ready" ||
        ready === undefined ||
        attempt.signal.aborted ||
        attempt.handedOff ||
        key !== ready.key
      )
        return yield* Effect.fail(unavailable());
      attempt.handedOff = true;
      return ready.thread;
    });
  return {
    startup: () => process?.startup?.(),
    factory: {
      open: (input) =>
        factory.open(input).pipe(
          Effect.map((runtime): NativeRuntime => {
            native = runtime;
            harness = input;
            return {
              ...runtime,
              get providerSession() {
                return runtime.providerSession;
              },
              // AdapterHarness adopts this completed setup into its own state without opening again.
              ensureThread: (input) => handoff({ method: "ensureThread", input }),
              resumeThread: (input) => handoff({ method: "resumeThread", input }),
              startTurn: (input) =>
                Effect.gen(function* () {
                  const attempt = current;
                  const ready = attempt?.installed;
                  const thread = ready?.thread;
                  const settings = yield* Effect.try({
                    try: () =>
                      stableStringify({
                        modelSelection: input.modelSelection,
                        runtimePolicy: input.runtimePolicy,
                      }),
                    catch: unavailable,
                  });
                  if (
                    attempt === undefined ||
                    attempt.phase !== "ready" ||
                    (attempt.handoffRequired && !attempt.handedOff) ||
                    attempt.signal.aborted ||
                    ready === undefined ||
                    thread === undefined ||
                    settings !== ready.settings ||
                    input.providerThread.providerSessionId !== thread.providerSessionId ||
                    input.providerThread.providerInstanceId !== thread.providerInstanceId ||
                    input.providerThread.appThreadId !== thread.appThreadId ||
                    input.providerThread.id !== thread.id ||
                    input.providerThread.nativeThreadRef?.nativeId !==
                      thread.nativeThreadRef?.nativeId
                  )
                    return yield* Effect.fail(unavailable());
                  attempt.phase = "started";
                  return yield* runtime.startTurn(input);
                }),
            };
          }),
        ),
    },
    completeMcpTurn: (epoch) => {
      const attempt = current;
      if (attempt?.configuration.epoch === epoch && attempt.phase === "started")
        attempt.phase = "completed";
    },
    configureMcp: (configuration, signal, load) => {
      const previous = current;
      if (
        previous !== undefined &&
        (previous.phase !== "completed" ||
          !previous.signal.aborted ||
          configuration.epoch <= previous.configuration.epoch)
      )
        return Effect.fail(unavailableInstallation());

      const attempt: McpAttempt = {
        configuration,
        signal,
        handoffRequired: previous === undefined,
        servers: Object.freeze({}),
        phase: "configuring",
        mapReads: 0,
        installed: undefined,
        handedOff: false,
      };
      current = attempt;
      return Effect.gen(function* () {
        const runtime = native;
        const input = harness;
        if (runtime === undefined || input === undefined || signal.aborted)
          return yield* Effect.fail(unavailableInstallation());
        if (!Number.isSafeInteger(configuration.epoch) || configuration.epoch <= 0)
          return yield* Effect.fail(
            new HarnessError({ operation: "turn", message: "Codex MCP epoch is invalid." }),
          );
        const requested =
          load.method === "ensureThread"
            ? load.input.existingProviderThread
            : load.input.providerThread;
        if (
          (load.input.threadId ?? requested?.appThreadId) !== input.session.threadId ||
          (requested !== undefined &&
            (requested.appThreadId !== input.session.threadId ||
              requested.providerSessionId !== input.session.providerSessionId ||
              requested.providerInstanceId !== runtime.instanceId ||
              requested.driver !== runtime.driver)) ||
          (input.checkpoint !== undefined &&
            (load.method !== "resumeThread" ||
              requested?.nativeThreadRef?.nativeId !==
                input.checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId))
        )
          return yield* Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Codex native setup belongs to another thread.",
            }),
          );
        attempt.servers = yield* Effect.try({
          try: () =>
            Object.freeze(
              Object.fromEntries(
                Object.entries(configuration.servers).map(([name, server]) => [
                  name,
                  Object.freeze({ url: server.url }),
                ]),
              ),
            ),
          catch: (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Codex MCP configuration is invalid.",
              cause,
            }),
        });
        const key = yield* Effect.try({
          try: () => loadKey(load),
          catch: (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Codex native setup is invalid.",
              cause,
            }),
        });
        const settings = yield* Effect.try({
          try: () =>
            stableStringify({
              modelSelection: load.input.modelSelection,
              runtimePolicy: load.input.runtimePolicy,
            }),
          catch: (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Codex native setup is invalid.",
              cause,
            }),
        });
        const thread = yield* (
          load.method === "ensureThread"
            ? runtime.ensureThread(load.input)
            : runtime.resumeThread(load.input)
        ).pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError({ operation: "turn", message: "Codex native setup failed.", cause }),
          ),
          Effect.raceFirst(mcpAborted(signal)),
        );
        if (
          signal.aborted ||
          attempt.mapReads !== 1 ||
          thread.appThreadId !== input.session.threadId ||
          thread.providerSessionId !== input.session.providerSessionId ||
          thread.providerInstanceId !== runtime.instanceId ||
          thread.driver !== runtime.driver ||
          thread.nativeThreadRef?.strength !== "strong" ||
          (requested !== undefined && thread.id !== requested.id) ||
          (requested?.nativeThreadRef !== null &&
            requested?.nativeThreadRef !== undefined &&
            requested.nativeThreadRef.nativeId !== thread.nativeThreadRef.nativeId)
        )
          return yield* Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Codex native setup did not preserve the bound identity.",
            }),
          );
        attempt.installed = { key, settings, thread };
        attempt.phase = "ready";
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit) && current === attempt) attempt.phase = "failed";
          }),
        ),
      );
    },
  };
}
