import {
  ProviderAdapterV2Event,
  ProviderAdapterV2Error,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { resolveClaudeCatalogContextWindowTokens } from "@signalbox/provider-claude/ClaudeModelCatalog";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { rpcStubOwner, readRpcData } from "../rpc/Resources.ts";
import { HarnessError, type HarnessOpenInput } from "./Harness.ts";
import type { HarnessRuntimeReporter } from "./HarnessProcessLifetime.ts";
import type { NativeHostBinding } from "./HarnessSessionHost.ts";
import type { Computer } from "../computer/Computer.ts";
import {
  claudeSdkMethods,
  claudeSdkOpenCodec,
  claudeSdkErrorCodec,
  claudeSdkSessionCodec,
  type ClaudeSdkHostService,
  type ClaudeCliProcessPort,
  type ClaudeSdkProcessContext,
  type ClaudeSdkMethod,
  type ClaudeSdkSessionPort,
} from "./ClaudeSdkHostProtocol.ts";

const isAdapterError = Schema.is(ProviderAdapterV2Error);
const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(ProviderAdapterV2Event));
const protocolError = (cause: unknown) =>
  new ProviderAdapterProtocolError({
    driver: ProviderDriverKind.make("claudeAgent"),
    detail: "Claude SDK host RPC failed.",
    cause,
  });

export interface ClaudeSdkNativeOptions<Files = Computer["files"]> {
  readonly sdkHost: ClaudeSdkHostService;
  readonly context: ClaudeSdkProcessContext;
  readonly openCli: (
    input: HarnessOpenInput<Files>,
    reporter: HarnessRuntimeReporter,
  ) => Effect.Effect<ClaudeCliProcessPort, HarnessError, Scope.Scope>;
}

/** Provider orchestration owns only async process and SDK capabilities. */
export function makeClaudeSdkNativeBinding<Files = Computer["files"]>(
  options: ClaudeSdkNativeOptions<Files>,
): NativeHostBinding<Files> {
  let session: ClaudeSdkSessionPort | undefined;
  let opened = false;
  let sequence = 0;
  function call<I, O>(
    method: ClaudeSdkMethod,
    codec: {
      readonly input: { readonly encode: (value: I) => unknown };
      readonly output: { readonly decode: (value: unknown) => O };
    },
    input: I,
    externalSignal?: AbortSignal,
  ): Effect.Effect<O, ProviderAdapterV2Error> {
    return Effect.tryPromise({
      try: async (effectSignal) => {
        const owner = session;
        if (owner === undefined) throw new Error("Claude SDK host has not opened");
        const signal =
          externalSignal === undefined
            ? effectSignal
            : AbortSignal.any([externalSignal, effectSignal]);
        signal.throwIfAborted();
        const id = String(++sequence);
        const abort = () => {
          void owner.cancel(id, signal.reason).catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const reply = await readRpcData(owner.execute(id, method, codec.input.encode(input)));
          if (!reply.ok) throw claudeSdkErrorCodec.decode(reply.error);
          return codec.output.decode(reply.value);
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      catch: (cause) => (isAdapterError(cause) ? cause : protocolError(cause)),
    });
  }
  return {
    factory: {
      open: (input, reporter) =>
        Effect.gen(function* () {
          if (opened)
            return yield* Effect.fail(
              new HarnessError({
                operation: "open",
                message: "Claude SDK host already owns a session.",
              }),
            );
          opened = true;
          const cli = yield* options.openCli(input, reporter);
          const remote = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                options.sdkHost.open(claudeSdkOpenCodec.encode(input), options.context, cli),
              catch: (cause) =>
                new HarnessError({
                  operation: "open",
                  message: "Claude SDK host could not open.",
                  cause,
                }),
            }),
            (remote) =>
              Effect.promise(async () => {
                using _owner = rpcStubOwner(remote);
                await remote.dispose();
              }),
          );
          session = remote;
          const description = yield* Effect.tryPromise({
            try: () => readRpcData(remote.describe()),
            catch: protocolError,
          });
          let providerSession = claudeSdkSessionCodec.decode(description.providerSession);
          const eventBytes = yield* Effect.tryPromise({
            try: () => remote.events(),
            catch: protocolError,
          });
          const events = Stream.fromReadableStream({
            evaluate: () => eventBytes,
            onError: protocolError,
          }).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.map((line) => {
              const event = decodeEvent(JSON.parse(line));
              if (event.type === "provider_session.updated")
                providerSession = event.providerSession;
              return event;
            }),
          );
          return {
            instanceId: providerSession.providerInstanceId,
            driver: providerSession.driver,
            providerSessionId: providerSession.id,
            get providerSession() {
              return providerSession;
            },
            events,
            backgroundTasksEndWithProcess: true,
            getModelContextWindow: (selection) =>
              resolveClaudeCatalogContextWindowTokens(description.modelCatalog, selection),
            ensureThread: (input) => call("ensureThread", claudeSdkMethods.ensureThread, input),
            resumeThread: (input) => call("resumeThread", claudeSdkMethods.resumeThread, input),
            startTurn: (input) => call("startTurn", claudeSdkMethods.startTurn, input),
            compactThread: (input) => call("compactThread", claudeSdkMethods.compactThread, input),
            steerTurn: (input) => call("steerTurn", claudeSdkMethods.steerTurn, input),
            interruptTurn: (input) => call("interruptTurn", claudeSdkMethods.interruptTurn, input),
            stopTask: (input) => call("stopTask", claudeSdkMethods.stopTask, input),
            stopSubagent: (input) => call("stopSubagent", claudeSdkMethods.stopSubagent, input),
            respondToRuntimeRequest: (input) =>
              call("respondToRuntimeRequest", claudeSdkMethods.respondToRuntimeRequest, input),
            readThreadSnapshot: (input) =>
              call("readThreadSnapshot", claudeSdkMethods.readThreadSnapshot, input),
            rollbackThread: (input) =>
              call("rollbackThread", claudeSdkMethods.rollbackThread, input),
            forkThread: (input) => call("forkThread", claudeSdkMethods.forkThread, input),
            hasPendingBackgroundWork: call(
              "hasPendingBackgroundWork",
              claudeSdkMethods.hasPendingBackgroundWork,
              undefined,
            ).pipe(Effect.orDie),
            hasPendingBackgroundWorkForThread: (input) =>
              call(
                "hasPendingBackgroundWorkForThread",
                claudeSdkMethods.hasPendingBackgroundWorkForThread,
                input,
              ).pipe(Effect.orDie),
          } satisfies ProviderAdapterV2SessionRuntime;
        }),
    },
    configureMcp: (configuration, signal, load) =>
      call("configureMcp", claudeSdkMethods.configureMcp, { configuration, load }, signal).pipe(
        Effect.mapError(
          (cause) =>
            new HarnessError({
              operation: "turn",
              message: "Claude SDK MCP installation failed.",
              cause,
            }),
        ),
      ),
  };
}
