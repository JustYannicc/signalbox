import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { ProviderTurnId } from "@t3tools/contracts";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { HarnessError } from "../Harness.ts";
import {
  makeReleaseModuleOmittedFailure,
  type HarnessRuntimeReporter,
} from "../HarnessProcessLifetime.ts";
import type { TurnState } from "./state.ts";
import { encodeHarnessTurnMilestone, type HarnessTurnStage } from "../HarnessTurnProgress.ts";

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(ProviderAdapterV2Event));
const eventRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

export const makeAdapterFailure = (
  output: Queue.Queue<RunnerItem, HarnessError | Cause.Done>,
  state: TurnState,
  now: () => number,
) => {
  const controller = new AbortController();
  let failure: HarnessError | undefined;
  let omissionFailure: HarnessError | undefined;
  let milestoneTurn: TurnState["active"];
  const milestones = new Set<HarnessTurnStage>();
  let contextTurn: TurnState["active"];
  const record = (error: HarnessError) => {
    const recorded = (failure ??= error);
    controller.abort(recorded);
    if (state.active !== undefined) {
      Deferred.doneUnsafe(state.active.began, Effect.fail(recorded));
      Deferred.doneUnsafe(state.active.started, Effect.fail(recorded));
    }
    Queue.failCauseUnsafe(output, Cause.fail(recorded));
  };
  const reporter: HarnessRuntimeReporter = {
    cliSpawnContext: (context) => {
      const current = state.active;
      if (current === undefined || failure !== undefined || contextTurn === current) return;
      contextTurn = current;
      Queue.offerUnsafe(output, {
        kind: "log",
        runId: current.input.runId,
        level: "info",
        message: JSON.stringify(context),
      });
    },
    turnMilestone: (stage) => {
      const current = state.active;
      if (current === undefined || failure !== undefined) return;
      if (milestoneTurn !== current) {
        milestoneTurn = current;
        milestones.clear();
      }
      if (milestones.has(stage)) return;
      milestones.add(stage);
      Queue.offerUnsafe(output, {
        kind: "log",
        runId: current.input.runId,
        level: "info",
        message: encodeHarnessTurnMilestone(stage),
      });
    },
    releaseModuleOmitted: (event, omission = makeReleaseModuleOmittedFailure(event)) => {
      const current = state.active;
      Queue.offerUnsafe(output, {
        kind: "log",
        runId: current?.input.runId ?? null,
        level: "warning",
        message: JSON.stringify(omission),
      });
      const error = new HarnessError({
        operation: "events",
        message: "A release module was omitted.",
        cause: omission,
      });
      omissionFailure ??= error;
      if (failure === undefined && current !== undefined) {
        const driver = current.providerThread.driver;
        const providerTurn = {
          ...(current.nativeTurn ?? {
            id: ProviderTurnId.make(`harness-omission:${current.input.runId}`),
            providerThreadId: current.providerThread.id,
            nodeId: current.input.rootNodeId,
            runAttemptId: current.input.attemptId,
            nativeTurnRef: null,
            ordinal: current.input.providerTurnOrdinal,
            startedAt: null,
          }),
          status: "failed" as const,
          completedAt: DateTime.makeUnsafe(now()),
        };
        const events: ProviderAdapterV2Event[] = [
          { type: "provider_turn.updated", driver, providerTurn },
          {
            type: "turn.terminal",
            driver,
            providerThreadId: current.providerThread.id,
            providerTurnId: providerTurn.id,
            runOrdinal: current.input.runOrdinal,
            failureItemOrdinal: current.nextItemOrdinal,
            status: "failed",
            failure: {
              class: "provider_error",
              code: omission.code,
              message: `${omission.message} ${omission.inputPath}`.slice(0, 4_096),
              retryable: false,
            },
            threadDisposition: "broken",
          },
        ];
        for (const value of events)
          Queue.offerUnsafe(output, {
            kind: "provider",
            runId: current.input.runId,
            event: eventRecord(encodeEvent(value)),
          });
        Deferred.doneUnsafe(current.began, Effect.fail(error));
        Deferred.doneUnsafe(current.started, Effect.fail(error));
        state.last = current;
        state.active = undefined;
      }
      record(error);
    },
  };
  return {
    record,
    reporter,
    signal: controller.signal,
    get current() {
      return failure;
    },
    get shutdown() {
      return omissionFailure;
    },
  };
};
