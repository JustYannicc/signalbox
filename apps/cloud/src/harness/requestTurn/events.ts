import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import type { HarnessRequestTurnTerminal } from "./contracts.ts";
import { failure } from "./gate.ts";

const decodeEvent = Schema.decodeUnknownEffect(Schema.toCodecJson(ProviderAdapterV2Event));

export interface RequestEvents {
  readonly turn: RunnerTurn;
  readonly done: Deferred.Deferred<HarnessRequestTurnTerminal, HarnessRequestFacetError>;
  terminal?: HarnessRequestTurnTerminal;
  native?: { readonly id: string; readonly ordinal: number };
}

export const observeEvent = (item: RunnerItem, work: RequestEvents) =>
  Effect.gen(function* () {
    if (work.terminal !== undefined || ("runId" in item && item.runId !== work.turn.runId))
      return yield* Effect.fail(failure("Harness event arrived outside its active turn."));
    if (item.kind !== "provider") return false;
    const event = yield* decodeEvent(item.event).pipe(
      Effect.mapError((cause) => failure("Harness provider event is invalid.", cause)),
    );
    const turn = work.turn;
    if (event.driver !== turn.providerThread.driver) return false;
    if (
      event.type === "provider_turn.updated" &&
      event.providerTurn.providerThreadId === turn.providerThread.id &&
      event.providerTurn.runAttemptId === turn.attemptId &&
      event.providerTurn.nodeId === turn.rootNodeId &&
      (work.native === undefined ||
        event.providerTurn.ordinal > work.native.ordinal ||
        (event.providerTurn.ordinal === work.native.ordinal &&
          event.providerTurn.id === work.native.id))
    ) {
      work.native = { id: event.providerTurn.id, ordinal: event.providerTurn.ordinal };
    }
    if (
      event.type !== "turn.terminal" ||
      event.providerThreadId !== turn.providerThread.id ||
      event.providerTurnId !== work.native?.id ||
      event.runOrdinal !== turn.runOrdinal
    )
      return false;
    work.terminal = item;
    return true;
  });
