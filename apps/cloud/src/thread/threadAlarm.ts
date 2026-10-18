import * as Effect from "effect/Effect";

import * as CloudAnalytics from "./diagnostics/CloudAnalytics.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";
import * as MachineBackend from "./runner/MachineBackend.ts";
import * as TurnReports from "./diagnostics/TurnReports.ts";
import * as TerminalOutbox from "./terminal/TerminalOutbox.ts";

/** Work that must resume immediately when an object wakes or rehydrates. */
export const hasImmediateWork = (work?: ThreadRunner.RunnerWork) =>
  Effect.gen(function* () {
    const engine = yield* ThreadEngine.ThreadEngine;
    // Undo recovery must run before runner callbacks, which remain fenced until it completes.
    if (yield* engine.hasTurnWork) return true;
    const runner = work ?? (yield* (yield* ThreadRunner.ThreadRunner).work);
    if (
      runner.needsUpkeep ||
      (yield* engine.hasPendingSummary) ||
      (yield* engine.hasPendingSearch) ||
      (yield* engine.hasPendingEvents) ||
      (yield* Effect.orDie((yield* TerminalOutbox.TerminalOutbox).hasPending)) ||
      (yield* Effect.forEach(
        MachineBackend.distinctBackends(yield* MachineBackend.MachineBackend),
        (backend) => backend.pending,
      )).some(Boolean)
    ) {
      return true;
    }
    // Live diagnostics arm their own alarms; a cold object checks for persisted leftovers.
    const projection = work === undefined ? yield* engine.projection : null;
    return (
      projection !== null &&
      ((yield* (yield* TurnReports.TurnReports).hasPending(projection)) ||
        (yield* (yield* CloudAnalytics.CloudAnalytics).hasPending))
    );
  });
