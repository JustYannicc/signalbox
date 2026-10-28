import { CODEX_DRIVER_KIND } from "@signalbox/provider-codex/defaults";
import type { CodexAdapterV2Options } from "@signalbox/provider-codex/runtime";
import { makeCodexAdapterV2 } from "@signalbox/provider-codex/runtime";
import type {
  CodexAppServerClientFactoryShape,
  CodexAppServerSessionClient,
} from "@signalbox/provider-codex/clientFactory";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { HarnessError, type HarnessOpenInput } from "./Harness.ts";
import {
  startCodexHarnessProcess,
  type CodexHarnessProcessOptions,
} from "./CodexHarnessProcess.ts";
import { createCodexFetch } from "./CodexNetwork.ts";
import { makeCodexProcessClient } from "./CodexTransport.ts";
import type { HarnessProcessObserver } from "./HarnessProcessLifetime.ts";
import { materializeFreshCodexCheckpoint } from "./codex/freshCheckpoint.ts";

export interface CodexIsolateAdapterOptions {
  readonly process: Omit<CodexHarnessProcessOptions, "signal">;
  readonly adapter: Omit<CodexAdapterV2Options, "clientFactory" | "environment" | "snapshotMode">;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly modelOrigins: ReadonlyArray<string>;
  readonly onStderr?: (bytes: Uint8Array) => Effect.Effect<void>;
  readonly processObserver?: HarnessProcessObserver;
}

export function makeCodexIsolateAdapter(options: CodexIsolateAdapterOptions): {
  readonly open: (
    input: HarnessOpenInput,
  ) => Effect.Effect<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    HarnessError | ProviderAdapter.ProviderAdapterV2Error,
    Scope.Scope
  >;
} {
  let opened = false;
  return {
    open: (input) =>
      Effect.gen(function* () {
        if (
          input.release.harness !== "codex" ||
          input.computer !== options.process.computer ||
          input.computer.threadId !== input.session.threadId ||
          input.session.modelSelection.instanceId !== options.adapter.instanceId
        )
          return yield* Effect.fail(
            new HarnessError({
              operation: "open",
              message: "Codex session identity does not match its facet.",
            }),
          );
        if (opened)
          return yield* Effect.fail(
            new HarnessError({
              operation: "open",
              message: "Codex factory requires fresh owned streams for another native session.",
            }),
          );
        opened = true;
        const sessionScope = yield* Scope.fork(yield* Scope.Scope);
        const open = Effect.gen(function* () {
          // The session outlives the open fiber; its scope owns network cancellation.
          const lifetime = new AbortController();
          yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()));
          const fetch = yield* Effect.try({
            try: () =>
              createCodexFetch({
                computer: input.computer,
                signal: lifetime.signal,
                modelOrigins: options.modelOrigins,
                modelTransport: input.modelTransport,
                fetch: options.process.fetch,
              }),
            catch: (cause) =>
              new HarnessError({
                operation: "open",
                message: "Codex network routes are invalid.",
                cause,
              }),
          });
          let nativeClient: CodexAppServerSessionClient | undefined;
          const clientFactory: CodexAppServerClientFactoryShape = {
            open: (session) =>
              Effect.gen(function* () {
                const process = yield* Effect.acquireRelease(
                  Effect.tryPromise({
                    try: () =>
                      startCodexHarnessProcess({
                        ...options.process,
                        fetch,
                        signal: lifetime.signal,
                      }),
                    catch: (cause) =>
                      new ProviderAdapter.ProviderAdapterOpenSessionError({
                        driver: CODEX_DRIVER_KIND,
                        providerSessionId: session.providerSessionId,
                        cause,
                      }),
                  }),
                  (process) => Effect.promise(() => process.dispose()),
                );
                yield* Effect.try({
                  try: () => options.processObserver?.started(process),
                  catch: (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CODEX_DRIVER_KIND,
                      providerSessionId: session.providerSessionId,
                      cause,
                    }),
                });
                const client = yield* makeCodexProcessClient(process, options.onStderr);
                nativeClient = client;
                yield* Effect.tryPromise({
                  try: () => process.ready,
                  catch: (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CODEX_DRIVER_KIND,
                      providerSessionId: session.providerSessionId,
                      cause,
                    }),
                });
                return client;
              }),
          };
          const adapter = yield* makeCodexAdapterV2({
            ...options.adapter,
            snapshotMode: "metadata",
            environment: options.process.environment,
            clientFactory,
          }).pipe(
            Effect.provideService(McpProviderSessions.McpProviderSessions, options.mcpSessions),
          );
          const runtime = yield* adapter.openSession(input.session);
          const creation = input.creation;
          if (creation === undefined) return runtime;
          let prepared = false;
          return {
            ...runtime,
            get providerSession() {
              return runtime.providerSession;
            },
            ensureThread: (threadInput) =>
              Effect.gen(function* () {
                if (
                  !prepared &&
                  (threadInput.existingProviderThread?.id !== creation.providerThread.id ||
                    threadInput.existingProviderThread.nativeThreadRef !== null)
                )
                  return yield* new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: CODEX_DRIVER_KIND,
                    threadId: input.session.threadId,
                    cause: "Fresh checkpoint preparation requires the unbound creation thread.",
                  });
                const thread = yield* runtime.ensureThread(threadInput);
                if (prepared) return thread;
                if (nativeClient === undefined)
                  return yield* new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: CODEX_DRIVER_KIND,
                    threadId: input.session.threadId,
                    cause: "Fresh checkpoint preparation has no native client.",
                  });
                yield* materializeFreshCodexCheckpoint({
                  runtime,
                  client: nativeClient.raw,
                  providerThread: thread,
                  threadId: input.session.threadId,
                  files: input.computer.files,
                  codexHome: options.process.bootstrap.codex_home,
                });
                prepared = true;
                return thread;
              }),
          } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
        });
        return yield* open.pipe(
          Scope.provide(sessionScope),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(sessionScope, exit) : Effect.void,
          ),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.sync(() => options.processObserver?.abandoned(exit.cause))
            : Effect.void,
        ),
      ),
  };
}
