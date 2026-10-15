import {
  automationEventMatches,
  WorkflowGraph,
  type AutomationError,
  type WorkflowEventTrigger,
  type WorkflowNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { stepArgs } from "../columns.ts";
import type { Settlement } from "../engineTypes.ts";
import { asRecord, fromJson, toJson } from "../json.ts";
import type { RunLinkStore } from "../runLinkStore.ts";
import type { StepRow, WorkflowStore } from "../WorkflowStore.ts";
import { whereMatches } from "./subscriptions.ts";

/**
 * `w.waitFor(label, { on, where?, timeout? })`: a step that waits for an
 * event from the same catalog event triggers use, matched the same way.
 *
 * A literal `on` is known from the run's diagram when it starts. From then on
 * every matching event in the run's project goes into the run's inbox,
 * whether or not a step is waiting yet, so one that arrives between two steps
 * isn't lost. A computed `on` (the built-in "Wait for" waits on whatever its
 * caller named) is only known once its step starts waiting, so it collects
 * from then on. A waiting step takes the oldest inbox event that matches its `on` and
 * `where`; each event goes to one step. A step only ever starts waiting and
 * then looks in the inbox, so an event racing the step's start is still
 * found.
 */

/** Events kept per run while no step takes them; the oldest go first. */
const INBOX_LIMIT = 200;

const decodeGraph = Schema.decodeSync(Schema.fromJsonString(WorkflowGraph));

type Envelope = Readonly<Record<string, unknown>> & {
  readonly event: string;
  readonly id: string;
  readonly projectId: string;
};

export interface RunWaitListener {
  readonly runId: string;
  readonly projectId: string;
  readonly patterns: ReadonlyArray<string>;
}

/** The `on` patterns of every `waitFor` in a diagram. */
export function waitPatterns(nodes: ReadonlyArray<WorkflowNode>): string[] {
  const found: string[] = [];
  const visit = (list: ReadonlyArray<WorkflowNode>) => {
    for (const node of list) {
      switch (node.type) {
        case "step": {
          const on = node.verb === "waitFor" ? node.detail.on : undefined;
          const value = on && "literal" in on ? on.literal : undefined;
          if (typeof value === "string") found.push(value);
          else if (Array.isArray(value))
            found.push(...value.filter((item): item is string => typeof item === "string"));
          break;
        }
        case "branch":
          for (const arm of node.arms) visit(arm.body);
          break;
        case "parallel":
          for (const arm of node.branches) visit(arm.body);
          break;
        case "loop":
          visit(node.body);
          break;
        case "try":
          visit(node.body);
          visit(node.failure);
          break;
        case "end":
          break;
      }
    }
  };
  visit(nodes);
  return [...new Set(found)];
}

/** What a `waitFor` step listens for: `on` patterns and `where` fields from its options. */
function stepListens(step: Pick<StepRow, "args_json">) {
  const options = asRecord(stepArgs(step)[0]);
  const on = options.on;
  const patterns =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.filter((item): item is string => typeof item === "string")
        : [];
  return { patterns, where: options.where as WorkflowEventTrigger["where"] };
}

/** Whether a `waitFor` step uses `on` rather than a named `event`. */
export const waitsOnEvents = (step: Pick<StepRow, "verb" | "args_json">) =>
  step.verb === "waitFor" && stepListens(step).patterns.length > 0;

export interface RunWaitDependencies {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  /** Settles a step and replays its run; false when it was already settled. */
  readonly complete: (
    runId: string,
    key: string,
    outcome: Settlement,
  ) => Effect.Effect<boolean, AutomationError>;
}

export const makeRunWaits = (deps: RunWaitDependencies) => {
  const { store, links } = deps;
  const patternsByVersion = new Map<string, ReadonlyArray<string>>();
  let listeners: ReadonlyArray<RunWaitListener> | null = null;
  let generation = 0;

  const versionPatterns = (automationId: string, version: number) =>
    Effect.gen(function* () {
      const key = `${automationId}@${version}`;
      const cached = patternsByVersion.get(key);
      if (cached) return cached;
      const row = yield* store.getVersion(automationId, version);
      const patterns = row ? waitPatterns(decodeGraph(row.graph_json).nodes) : [];
      patternsByVersion.set(key, patterns);
      return patterns;
    });

  /** Running runs that wait for events, rebuilt only after a run starts or ends or a step starts waiting. */
  const current = Effect.suspend(() => {
    if (listeners) return Effect.succeed(listeners);
    const seen = generation;
    return Effect.gen(function* () {
      const built: RunWaitListener[] = [];
      const projects = new Map<string, string | undefined>();
      // A computed `on` isn't in the diagram; its step's arguments say what it waits for.
      const computed = new Map<string, string[]>();
      for (const step of yield* store.waitingWaitForSteps()) {
        computed.set(step.run_id, [
          ...(computed.get(step.run_id) ?? []),
          ...stepListens(step).patterns,
        ]);
      }
      for (const run of yield* store.runningRuns()) {
        const patterns = [
          ...new Set([
            ...(yield* versionPatterns(run.automation_id, run.version)),
            ...(computed.get(run.run_id) ?? []),
          ]),
        ];
        if (patterns.length === 0) continue;
        if (!projects.has(run.automation_id))
          projects.set(
            run.automation_id,
            (yield* store.getAutomation(run.automation_id))?.project_id,
          );
        const projectId = projects.get(run.automation_id);
        if (projectId) built.push({ runId: run.run_id, projectId, patterns });
      }
      if (seen === generation) listeners = built;
      return built;
    });
  });

  /** Call when a run starts or ends. */
  const invalidate = () => {
    listeners = null;
    generation += 1;
  };

  /** A `waitFor` step started waiting: listen for a computed `on` its run's listener lacks. */
  const stepWaiting = (step: Pick<StepRow, "run_id" | "verb" | "args_json">) =>
    Effect.sync(() => {
      const known = listeners?.find((listener) => listener.runId === step.run_id)?.patterns ?? [];
      if (stepListens(step).patterns.some((pattern) => !known.includes(pattern))) invalidate();
    });

  /** Runs whose code waits for `name`; cheap enough to ask for every event. */
  const lookup = (name: string) =>
    current.pipe(
      Effect.map((all) =>
        all.filter((listener) =>
          listener.patterns.some((pattern) => automationEventMatches(pattern, name)),
        ),
      ),
    );

  /** Hands a run's waiting `waitFor` steps the oldest inbox events that match them. */
  const deliverPending = (runId: string) =>
    Effect.gen(function* () {
      const waiting = (yield* store.listSteps(runId)).filter(
        (step) => step.status === "waiting" && waitsOnEvents(step),
      );
      if (waiting.length === 0) return;
      const inbox = yield* links.unconsumed(runId);
      if (inbox.length === 0) return;
      const taken = new Set<number>();
      for (const step of waiting) {
        const { patterns, where } = stepListens(step);
        for (const event of inbox) {
          if (taken.has(event.seq)) continue;
          if (!patterns.some((pattern) => automationEventMatches(pattern, event.name))) continue;
          const envelope = asRecord(fromJson(event.envelope_json));
          if (!whereMatches(where, envelope)) continue;
          if (!(yield* links.consume(runId, event.seq, step.step_key))) continue;
          taken.add(event.seq);
          yield* deps.complete(runId, step.step_key, { ok: true, value: envelope });
          break;
        }
      }
    });

  /** Keeps an event for every run in its project that waits for it, then wakes their steps. */
  const deliver = (envelope: Envelope, matched: ReadonlyArray<RunWaitListener>) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      for (const listener of matched) {
        if (listener.projectId !== envelope.projectId) continue;
        // A run never waits on its own run's events.
        if (envelope.automationRunId === listener.runId) continue;
        const kept = yield* links.keepEvent({
          run_id: listener.runId,
          event_id: envelope.id,
          name: envelope.event,
          envelope_json: toJson(envelope),
          received_at: at,
        });
        if (!kept) continue;
        yield* links.trimInbox(listener.runId, INBOX_LIMIT);
        yield* deliverPending(listener.runId);
      }
    });

  /** A run ended: its inbox goes, and it stops listening. */
  const ended = (runId: string) =>
    Effect.sync(invalidate).pipe(Effect.andThen(links.trimInbox(runId, 0)));

  return { lookup, deliver, deliverPending, invalidate, stepWaiting, ended };
};

export type RunWaits = ReturnType<typeof makeRunWaits>;
