import type { AutomationError, AutomationNotice, AutomationRunStatus } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

import type { Attachments } from "./attachments.ts";
import type { EndRun, EngineServices, LaunchRun, RunOutcome, Settlement } from "./engineTypes.ts";
import type { EventTriggers } from "./events/eventTriggers.ts";
import type { ExternalRuns } from "./external.ts";
import type { RunWaits } from "./events/runWaits.ts";
import type { AutomationFunctions, AutomationThreads } from "./host.ts";
import type { Change } from "./liveFeed.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import type { RunLogs } from "./runLog.ts";
import type { StartStep } from "./startStep.ts";
import type { AutomationRow, RunRow, StepRow, WorkflowStore } from "./WorkflowStore.ts";

/** Drives automation runs through Cloudflare Workflows while the host owns their records. */
export interface RunDriver {
  /** A step settled from outside its run (an answer, an event, a finished agent): wake the run. */
  readonly settled: (
    runId: string,
    key: string,
    outcome: Settlement,
  ) => Effect.Effect<void, AutomationError>;
  /** A run was recorded: start running it. */
  readonly launched: (runId: string) => Effect.Effect<void, AutomationError>;
  /** A run ended; stop whatever still works for it. */
  readonly ended: (runId: string, status: AutomationRunStatus) => Effect.Effect<void>;
  /** Settles an agent step whose thread's run ended; false while it still runs. */
  readonly settleThreadStep: (step: StepRow) => Effect.Effect<boolean, AutomationError>;
  /** Due timed work; the host calls it on its clock. */
  readonly tick: Effect.Effect<void, AutomationError>;
  /** Counts work in flight, so `drain` waits for it. */
  readonly adjustBusy: (delta: number) => Effect.Effect<void>;
  /** Waits until nothing the driver started is still working. Waiting steps don't count. */
  readonly drain: Effect.Effect<void>;
}

/** The engine pieces a driver builds on. */
export interface EngineInternals {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly threads: AutomationThreads["Service"];
  readonly services: Context.Context<EngineServices>;
  readonly functions: AutomationFunctions["Service"];
  readonly external: ExternalRuns;
  readonly runLogs: RunLogs;
  readonly runWaits: RunWaits;
  readonly attachments: Attachments;
  readonly events: EventTriggers;
  readonly notices: PubSub.PubSub<AutomationNotice>;
  readonly scope: Scope.Scope;
  readonly startStep: StartStep;
  readonly changed: (change: Change) => Effect.Effect<void>;
  readonly runChanged: (runId: string, summary: boolean) => Effect.Effect<void, AutomationError>;
  /** Tells people once, on a step's one move into waiting or done. */
  readonly announce: (automation: AutomationRow, step: StepRow) => Effect.Effect<void>;
  /** Records a step's outcome and lets the driver wake its run. False when it was already settled. */
  readonly complete: (
    runId: string,
    key: string,
    outcome: Settlement,
  ) => Effect.Effect<boolean, AutomationError>;
  readonly endRun: EndRun;
  readonly endRunById: (
    runId: string,
    outcome: Extract<RunOutcome, { readonly status: "failed" | "cancelled" }>,
  ) => Effect.Effect<boolean, AutomationError>;
  readonly launchRun: LaunchRun;
  /** `return w.restart(input)`: ends the run and starts its continuation (restart.ts). */
  readonly restart: (
    run: RunRow,
    automation: AutomationRow,
    input: unknown,
  ) => Effect.Effect<void, AutomationError>;
  readonly automationOfRun: (
    runId: string,
  ) => Effect.Effect<AutomationRow | undefined, AutomationError>;
  readonly ignoreFailure: (
    what: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A | void, never, R>;
}
