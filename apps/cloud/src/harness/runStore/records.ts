import * as Schema from "effect/Schema";
import { HarnessRunStoreCommand, State } from "./schemas.ts";
import { requestSnapshot } from "./requestSchemas.ts";
import { validateRequests } from "./requestInvariants.ts";
import { fail, HarnessRunStoreError } from "./errors.ts";
import { requestVersion } from "./format.ts";
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const commandDecoder = Schema.decodeUnknownSync(HarnessRunStoreCommand, {
  onExcessProperty: "error",
});
const stateDecoder = Schema.decodeUnknownSync(State, { onExcessProperty: "error" });
export function decodeCommand(value: unknown) {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string" || byteLength(json) > 65536) return fail("INVALID");
    return commandDecoder(JSON.parse(json));
  } catch (error) {
    if (error instanceof HarnessRunStoreError) throw error;
    throw new HarnessRunStoreError("INVALID", { cause: error });
  }
}
export function encodeState(state: State) {
  const json = JSON.stringify(state);
  if (byteLength(json) > 262144) return fail("LIMIT");
  return json;
}
export function decodeState(value: unknown, runId: string): State {
  try {
    if (typeof value !== "string" || byteLength(value) > 262144) return fail("CORRUPT");
    const state = stateDecoder(JSON.parse(value));
    if ((state.version === requestVersion) !== (state.requests !== undefined))
      return fail("CORRUPT");
    const last = state.claims.at(-1);
    if (state.seed.identity.runId !== runId || !last) return fail("CORRUPT");
    if (state.claims.some((claim, i) => claim.epoch !== i + 1 || claim.expectedEpoch !== i))
      return fail("CORRUPT");
    if (
      new Set(state.claims.map((claim) => claim.claimId)).size !== state.claims.length ||
      new Set(state.claims.map((claim) => claim.requestId)).size !== state.claims.length ||
      new Set(state.claims.map((claim) => claim.supervisorKey)).size !== state.claims.length ||
      state.claims.some(
        (claim) =>
          claim.supervisorKey === state.controlKey ||
          claim.supervisorKey === state.invocation?.publisherKey,
      ) ||
      state.invocation?.publisherKey === state.controlKey
    )
      return fail("CORRUPT");
    if (!state.invocation && (state.progress || state.terminal)) return fail("CORRUPT");
    if (
      state.invocation &&
      (state.invocation.declaredEpoch > last.epoch || (state.invocation.retired && !state.terminal))
    )
      return fail("CORRUPT");
    if (state.terminal && state.terminal.sequence !== (state.progress?.sequence ?? 0) + 1)
      return fail("CORRUPT");
    if (
      state.receipts.some((receipt) => receipt.epoch > last.epoch) ||
      new Set(state.receipts.map((receipt) => receipt.receiptId)).size !== state.receipts.length
    )
      return fail("CORRUPT");
    if (
      state.intents.some((intent) => state.claims[intent.epoch - 1]?.claimId !== intent.claimId) ||
      new Set(state.intents.map((intent) => intent.intentId)).size !== state.intents.length
    )
      return fail("CORRUPT");
    validateRequests(state);
    return state;
  } catch (error) {
    if (error instanceof HarnessRunStoreError) throw error;
    throw new HarnessRunStoreError("CORRUPT", { cause: error });
  }
}

export function snapshot(state: State) {
  const supervisor = state.claims.at(-1);
  if (!supervisor) return fail("CORRUPT");
  return {
    version: state.version,
    seed: state.seed,
    supervisor: {
      epoch: supervisor.epoch,
      claimId: supervisor.claimId,
      requestId: supervisor.requestId,
      expectedEpoch: supervisor.expectedEpoch,
    },
    invocation:
      state.invocation === null
        ? null
        : {
            declaration: state.invocation.declaration,
            declaredEpoch: state.invocation.declaredEpoch,
            retired: state.invocation.retired,
          },
    progress: state.progress,
    terminal: state.terminal,
    receipts: state.receipts,
    intents: state.intents,
    ...(state.requests ? { requests: requestSnapshot(state.requests) } : {}),
  };
}
export type HarnessRunSnapshot = ReturnType<typeof snapshot>;
export interface HarnessRunStoreResult {
  readonly action:
    | "recorded"
    | "unchanged"
    | "launch-once"
    | "observe-only"
    | "execute-once"
    | "committed"
    | "indeterminate"
    | "not-applied";
  readonly snapshot: HarnessRunSnapshot;
}
export type Decision = { readonly state: State; readonly action: HarnessRunStoreResult["action"] };
