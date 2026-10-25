import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { createProductClaudeHarnessSessionHost } from "../../ProductClaudeHarnessSessionHost.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { makeContinuationHostInputs as portableInputs } from "./continuationHostInputs.ts";

const makeContinuationHostInputs = (
  batch: boolean,
  opaque = false,
  binding: "explicit" | "unjoined" | "native" = "explicit",
  modelRequests = false,
  selection?: ModelSelection,
) =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
      Effect.sync(() => value.dispose()),
    );
    return yield* portableInputs(database.open(), batch, opaque, binding, modelRequests, selection);
  });

export const continuationHostInputs = makeContinuationHostInputs(false);
export const localDomainHostInputs = makeContinuationHostInputs(false, false, "explicit", true, {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
});
export const batchContinuationHostInputs = makeContinuationHostInputs(true);
export const boundaryBatchContinuationHostInputs = makeContinuationHostInputs(true, true);
export const unjoinedBatchContinuationHostInputs = makeContinuationHostInputs(
  true,
  false,
  "unjoined",
);
export const nativeBoundBatchContinuationHostInputs = makeContinuationHostInputs(
  true,
  true,
  "native",
);

export const continuationHostFixture = Effect.gen(function* () {
  const input = yield* continuationHostInputs;
  const host = yield* createProductClaudeHarnessSessionHost(input.hostOptions);
  yield* Effect.addFinalizer(() => host.dispose.pipe(Effect.orDie));
  yield* host.seed("assets");
  yield* host.seed("programs");
  const session = yield* host.open({
    session: input.sessionInput,
    bootAttemptId: "claude-continuation",
  });
  return { ...input, host, session };
});
