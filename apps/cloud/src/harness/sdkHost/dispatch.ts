import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Error,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  claudeSdkMethods,
  claudeSdkErrorCodec,
  type ClaudeSdkMethod,
  type ClaudeSdkReply,
} from "../ClaudeSdkHostProtocol.ts";
import type { HarnessError } from "../Harness.ts";
import type { NativeHostBinding } from "../HarnessSessionHost.ts";

const unsupported = (method: string) =>
  Effect.fail(
    new ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("claudeAgent"),
      detail: `Claude SDK host has no ${method} capability.`,
    }),
  );

function procedure<I, O>(
  codec: {
    readonly input: { readonly decode: (value: unknown) => I };
    readonly output: { readonly encode: (value: O) => unknown };
  },
  run: (input: I) => Effect.Effect<O, HarnessError | ProviderAdapterV2Error>,
) {
  return (raw: unknown) =>
    Effect.suspend(() => run(codec.input.decode(raw))).pipe(
      Effect.match({
        onSuccess: (value): ClaudeSdkReply => ({ ok: true, value: codec.output.encode(value) }),
        onFailure: (error): ClaudeSdkReply => ({
          ok: false,
          error: claudeSdkErrorCodec.encode(error),
        }),
      }),
    );
}

export function claudeSdkDispatch(
  runtime: ProviderAdapterV2SessionRuntime,
  configure: NativeHostBinding["configureMcp"],
  signal: AbortSignal,
) {
  return {
    ensureThread: procedure(claudeSdkMethods.ensureThread, runtime.ensureThread),
    resumeThread: procedure(claudeSdkMethods.resumeThread, runtime.resumeThread),
    startTurn: procedure(claudeSdkMethods.startTurn, runtime.startTurn),
    compactThread: procedure(
      claudeSdkMethods.compactThread,
      (input) => runtime.compactThread?.(input) ?? unsupported("compactThread"),
    ),
    steerTurn: procedure(claudeSdkMethods.steerTurn, runtime.steerTurn),
    interruptTurn: procedure(claudeSdkMethods.interruptTurn, runtime.interruptTurn),
    stopTask: procedure(
      claudeSdkMethods.stopTask,
      (input) => runtime.stopTask?.(input) ?? unsupported("stopTask"),
    ),
    stopSubagent: procedure(
      claudeSdkMethods.stopSubagent,
      (input) => runtime.stopSubagent?.(input) ?? unsupported("stopSubagent"),
    ),
    respondToRuntimeRequest: procedure(
      claudeSdkMethods.respondToRuntimeRequest,
      runtime.respondToRuntimeRequest,
    ),
    readThreadSnapshot: procedure(claudeSdkMethods.readThreadSnapshot, runtime.readThreadSnapshot),
    rollbackThread: procedure(claudeSdkMethods.rollbackThread, runtime.rollbackThread),
    forkThread: procedure(claudeSdkMethods.forkThread, runtime.forkThread),
    hasPendingBackgroundWork: procedure(
      claudeSdkMethods.hasPendingBackgroundWork,
      () => runtime.hasPendingBackgroundWork ?? Effect.succeed(false),
    ),
    hasPendingBackgroundWorkForThread: procedure(
      claudeSdkMethods.hasPendingBackgroundWorkForThread,
      (input) =>
        runtime.hasPendingBackgroundWorkForThread?.(input) ??
        runtime.hasPendingBackgroundWork ??
        Effect.succeed(false),
    ),
    configureMcp: procedure(claudeSdkMethods.configureMcp, ({ configuration, load }) =>
      configure(configuration, signal, load),
    ),
  } satisfies Record<ClaudeSdkMethod, (raw: unknown) => Effect.Effect<ClaudeSdkReply>>;
}
