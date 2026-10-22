import { CODEX_DRIVER_KIND } from "@signalbox/provider-codex/defaults";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
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

/** One MCP map and one real native setup belong to this incarnation. */
export function makeCodexNativeHostBinding(
  options: CodexNativeHostBindingOptions,
): NativeHostBinding {
  let native: NativeRuntime | undefined;
  let process: HarnessOwnedProcess | undefined;
  let harness: HarnessOpenInput | undefined;
  let claimed = false;
  let mapReads = 0;
  let staged: { servers: NativeMcpConfiguration["servers"]; signal: AbortSignal } | undefined;
  let installed:
    | { key: string; settings: string; thread: OrchestrationV2ProviderThread }
    | undefined;
  let handedOff = false;
  let started = false;
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
            if (staged === undefined) throw new Error("Codex MCP map is not installed.");
            staged.signal.throwIfAborted();
            if (++mapReads !== 1) throw new Error("Codex MCP map was already consumed.");
            return staged.servers;
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
      const ready = installed;
      const key = yield* Effect.try({ try: () => loadKey(load), catch: unavailable });
      if (ready === undefined || staged?.signal.aborted !== false || handedOff || key !== ready.key)
        return yield* Effect.fail(unavailable());
      handedOff = true;
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
                  const thread = installed?.thread;
                  const settings = yield* Effect.try({
                    try: () =>
                      stableStringify({
                        modelSelection: input.modelSelection,
                        runtimePolicy: input.runtimePolicy,
                      }),
                    catch: unavailable,
                  });
                  if (
                    !handedOff ||
                    started ||
                    staged?.signal.aborted !== false ||
                    thread === undefined ||
                    settings !== installed?.settings ||
                    input.providerThread.providerSessionId !== thread.providerSessionId ||
                    input.providerThread.providerInstanceId !== thread.providerInstanceId ||
                    input.providerThread.appThreadId !== thread.appThreadId ||
                    input.providerThread.id !== thread.id ||
                    input.providerThread.nativeThreadRef?.nativeId !==
                      thread.nativeThreadRef?.nativeId
                  )
                    return yield* Effect.fail(unavailable());
                  started = true;
                  return yield* runtime.startTurn(input);
                }),
            };
          }),
        ),
    },
    configureMcp: (configuration, signal, load) =>
      Effect.gen(function* () {
        const runtime = native;
        const input = harness;
        if (runtime === undefined || input === undefined || claimed)
          return yield* Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Codex MCP installation is unavailable.",
            }),
          );
        claimed = true;
        if (signal.aborted)
          return yield* Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Codex MCP installation is unavailable.",
            }),
          );
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
        const key = yield* Effect.try({
          try: () => loadKey(load),
          catch: (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Codex native setup is invalid.",
              cause,
            }),
        });
        const settings = stableStringify({
          modelSelection: load.input.modelSelection,
          runtimePolicy: load.input.runtimePolicy,
        });
        const servers = Object.freeze(
          Object.fromEntries(
            Object.entries(configuration.servers).map(([name, server]) => [
              name,
              Object.freeze({ url: server.url }),
            ]),
          ),
        );
        staged = { servers, signal };
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
          mapReads !== 1 ||
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
        installed = { key, settings, thread };
      }),
  };
}
