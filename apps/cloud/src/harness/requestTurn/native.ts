import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import type { RequestGate } from "./gate.ts";

export function gateNativeRuntime(
  runtime: ProviderAdapterV2SessionRuntime,
  gate: RequestGate,
): ProviderAdapterV2SessionRuntime {
  const admit = <A>(
    method: string,
    operation: () => Effect.Effect<A, ProviderAdapterV2Error>,
    outside = true,
  ) =>
    gate.native(operation, outside).pipe(
      Effect.mapError((cause) =>
        cause instanceof HarnessRequestFacetError
          ? new ProviderAdapterProtocolError({
              driver: runtime.driver,
              detail: `Harness request denied native ${method}`,
              cause,
            })
          : cause,
      ),
    );
  return {
    ...runtime,
    get providerSession() {
      return runtime.providerSession;
    },
    ensureThread: (input) => admit("ensureThread", () => runtime.ensureThread(input)),
    resumeThread: (input) => admit("resumeThread", () => runtime.resumeThread(input)),
    startTurn: (input) => admit("startTurn", () => runtime.startTurn(input)),
    steerTurn: (input) => admit("steerTurn", () => runtime.steerTurn(input)),
    respondToRuntimeRequest: (input) =>
      admit("respondToRuntimeRequest", () => runtime.respondToRuntimeRequest(input)),
    rollbackThread: (input) => admit("rollbackThread", () => runtime.rollbackThread(input)),
    forkThread: (input) => admit("forkThread", () => runtime.forkThread(input)),
    readThreadSnapshot: (input) =>
      admit("readThreadSnapshot", () => runtime.readThreadSnapshot(input), false),
    // Cooperative stop stays available without active authority. A restart admits new work.
    interruptTurn: (input) =>
      input.requestRuntimeRestart
        ? admit("interruptTurn.restart", () => runtime.interruptTurn(input))
        : runtime.interruptTurn(input),
    ...(runtime.injectHistory === undefined
      ? {}
      : {
          injectHistory: (
            input: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["injectHistory"]>>[0],
          ) => admit("injectHistory", () => runtime.injectHistory!(input)),
        }),
    ...(runtime.compactThread === undefined
      ? {}
      : {
          compactThread: (
            input: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["compactThread"]>>[0],
          ) => admit("compactThread", () => runtime.compactThread!(input)),
        }),
    ...(runtime.uploadFeedback === undefined
      ? {}
      : {
          uploadFeedback: (
            input: Parameters<NonNullable<ProviderAdapterV2SessionRuntime["uploadFeedback"]>>[0],
          ) => admit("uploadFeedback", () => runtime.uploadFeedback!(input)),
        }),
    ...(runtime.mcpApps === undefined
      ? {}
      : {
          mcpApps: {
            listTools: (
              input: Parameters<
                NonNullable<ProviderAdapterV2SessionRuntime["mcpApps"]>["listTools"]
              >[0],
            ) => admit("mcpApps.listTools", () => runtime.mcpApps!.listTools(input)),
            callTool: (
              input: Parameters<
                NonNullable<ProviderAdapterV2SessionRuntime["mcpApps"]>["callTool"]
              >[0],
            ) => admit("mcpApps.callTool", () => runtime.mcpApps!.callTool(input)),
            readResource: (
              input: Parameters<
                NonNullable<ProviderAdapterV2SessionRuntime["mcpApps"]>["readResource"]
              >[0],
            ) => admit("mcpApps.readResource", () => runtime.mcpApps!.readResource(input)),
          },
        }),
  };
}
