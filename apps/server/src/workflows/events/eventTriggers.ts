import {
  automationEventSpec,
  ThreadId,
  type AutomationEventName,
  type AutomationNotice,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import type { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import type { LaunchRun } from "../engineTypes.ts";
import { logFailure } from "../errors.ts";
import { eventsPausedNotice } from "../notices.ts";
import { MAX_START_DEPTH } from "../startStep.ts";
import type { AutomationRow, WorkflowStore } from "../WorkflowStore.ts";
import type { ReadError } from "./candidate.ts";
import { candidatesFor, type Actor, type Candidate, type EventReads } from "./normalize.ts";
import {
  ACTORS,
  buildIndex,
  whereMatches,
  type Subscription,
  type SubscriptionIndex,
} from "./subscriptions.ts";

/**
 * Event triggers: matches every domain event and automation event against
 * the automations listening for it, and starts their runs.
 *
 * Matching is an in-memory index (exact names plus a short wildcard list),
 * rebuilt only after an automation is saved, toggled or deleted, so events
 * nobody listens to never touch the database. Matched events are handled by
 * one worker fiber, so slow reads never hold up the domain event stream, and
 * one bad event or automation is logged and skipped.
 *
 * Loop guards: threads and turns automations started don't trigger unless a
 * trigger sets `includeAutomationThreads` (their messages carry
 * `automation:` ids); an automation never triggers on its own runs' events;
 * runs started by automation events count toward the `w.start` depth limit;
 * and an automation whose events start more than `maxRunsPerMinute` runs in a
 * minute has its event triggers paused until it's saved or switched again.
 */

const MINUTE_MS = 60_000;

type Envelope = Readonly<Record<string, unknown>> & {
  readonly event: string;
  readonly id: string;
  readonly projectId: string;
};

interface DeliveryContext {
  readonly actor?: Actor | undefined;
  /** Whether automations caused it, read only when a trigger cares. */
  readonly fromAutomation: Effect.Effect<boolean, ReadError>;
  readonly sourceAutomationId?: string;
  readonly depth: number;
}

type Work =
  | {
      readonly type: "domain";
      readonly event: OrchestrationV2DomainEvent;
      readonly hits: ReadonlyArray<{
        readonly candidate: Candidate;
        readonly subs: ReadonlyArray<Subscription>;
      }>;
    }
  | {
      readonly type: "ready";
      readonly envelope: Envelope;
      readonly subs: ReadonlyArray<Subscription>;
      readonly context: DeliveryContext;
    };

const isAutomationId = (id: string | null | undefined) => id?.startsWith("automation:") === true;

export interface EventTriggerDependencies {
  readonly store: WorkflowStore;
  readonly threads: ThreadManagementService["Service"];
  /** Counts work in flight, so the engine's drain waits for matched events. */
  readonly adjustBusy: (delta: number) => Effect.Effect<void>;
  readonly notify: (notice: AutomationNotice) => Effect.Effect<void>;
  readonly launchRun: LaunchRun;
}

export const makeEventTriggers = (deps: EventTriggerDependencies) =>
  Effect.gen(function* () {
    const { store, threads } = deps;
    let index: SubscriptionIndex | null = null;
    let generation = 0;
    const paused = new Set<string>();
    const starts = new Map<string, number[]>();
    /** Each automation's latest event-started run, for the pause notice's link. */
    const lastRuns = new Map<string, string>();
    const work = yield* Queue.unbounded<Work>();
    const logged = (what: string) => logFailure(`Automation event ${what} failed`);

    const currentIndex = Effect.suspend(() => {
      if (index) return Effect.succeed(index);
      const seen = generation;
      return store.listAutomations().pipe(
        Effect.map((rows) => {
          const built = buildIndex(rows);
          if (seen === generation) index = built;
          return built;
        }),
      );
    });

    /** Call when an automation's definition changes (saved, published, switched, deleted): rebuilds the index and lifts a rate pause. */
    const invalidate = (automationId: string) => {
      index = null;
      generation += 1;
      paused.delete(automationId);
      starts.delete(automationId);
    };

    const enqueue = (item: Work) =>
      deps.adjustBusy(1).pipe(Effect.andThen(Queue.offer(work, item)), Effect.asVoid);

    /** Runs in the domain stream's fiber: a lookup per candidate, and nothing more for events nobody wants. */
    const offer = (event: OrchestrationV2DomainEvent) =>
      Effect.gen(function* () {
        const current = yield* currentIndex;
        if (current.empty) return;
        const hits = candidatesFor(event).flatMap((candidate) => {
          const subs = current.lookup(candidate.name);
          return subs.length > 0 ? [{ candidate, subs }] : [];
        });
        if (hits.length > 0) yield* enqueue({ type: "domain", event, hits });
      }).pipe(logged("matching"));

    /** An automation run's own event. Reads the run only when someone listens. */
    const automationEvent = (
      name: AutomationEventName,
      runId: string,
      fields: Readonly<Record<string, unknown>> = {},
    ) =>
      Effect.gen(function* () {
        const current = yield* currentIndex;
        const subs = current.empty ? [] : current.lookup(name);
        if (subs.length === 0) return;
        const run = yield* store.getRun(runId);
        const automation = run ? yield* store.getAutomation(run.automation_id) : undefined;
        if (!run || !automation) return;
        const stepKey = typeof fields.stepKey === "string" ? `:${fields.stepKey}` : "";
        const envelope: Envelope = {
          event: name,
          id: `${name}:${runId}${stepKey}`,
          at: DateTime.formatIso(yield* DateTime.now),
          projectId: automation.project_id,
          automationId: automation.automation_id,
          automationName: automation.name,
          automationRunId: runId,
          ...fields,
        };
        yield* enqueue({
          type: "ready",
          envelope,
          subs,
          context: {
            fromAutomation: Effect.succeed(false),
            sourceAutomationId: automation.automation_id,
            depth: run.depth,
          },
        });
      }).pipe(logged("publishing"));

    /** A turn or thread automations started: the thread's first message, or this turn's, was theirs. */
    const automationCaused = (event: OrchestrationV2DomainEvent, reads: EventReads) =>
      Effect.gen(function* () {
        const shell = yield* reads.shell;
        if (shell?.createdBy !== "system" && event.runId === undefined) return false;
        const { runs } = yield* threads.getThreadRecords(event.threadId, ["runs"]);
        const first = runs.toSorted((left, right) => left.ordinal - right.ordinal)[0];
        if (shell?.createdBy === "system" && isAutomationId(first?.userMessageId)) return true;
        const run = runs.find((candidate) => candidate.id === event.runId);
        return isAutomationId(run?.userMessageId);
      });

    const passes = (sub: Subscription, envelope: Envelope, context: DeliveryContext) =>
      Effect.gen(function* () {
        const { trigger, automation } = sub;
        if (
          (trigger.scope ?? "project") === "project" &&
          envelope.projectId !== automation.project_id
        )
          return false;
        if (automationEventSpec(envelope.event)?.from) {
          const allowed = ACTORS[trigger.from ?? "people"];
          if (!context.actor || !allowed.includes(context.actor)) return false;
        }
        if (!whereMatches(trigger.where, envelope)) return false;
        if (trigger.includeAutomationThreads !== true && (yield* context.fromAutomation))
          return false;
        return true;
      });

    const pause = (automation: AutomationRow, limit: number, at: string, runId: string) =>
      Effect.gen(function* () {
        paused.add(automation.automation_id);
        yield* Effect.logWarning("Automation event triggers paused", {
          automationId: automation.automation_id,
          limit,
        });
        yield* deps.notify(eventsPausedNotice({ automation, limit, at, runId }));
      });

    const start = (
      automation: AutomationRow,
      limit: number,
      envelope: Envelope,
      context: DeliveryContext,
    ) =>
      Effect.gen(function* () {
        const id = automation.automation_id;
        if (context.depth >= MAX_START_DEPTH) {
          return yield* Effect.logWarning("Automation event chain too deep; not starting", {
            automationId: id,
            event: envelope.event,
          });
        }
        if (automation.overlap === "skip" && (yield* store.runningRunsOf(id)).length > 0) return;
        const now = yield* DateTime.now;
        const at = DateTime.formatIso(now);
        const ms = now.epochMilliseconds;
        const recent = (starts.get(id) ?? []).filter((time) => time > ms - MINUTE_MS);
        starts.set(id, recent);
        if (recent.length >= limit)
          return yield* pause(automation, limit, at, lastRuns.get(id) ?? "");
        const started = yield* deps.launchRun({
          automation,
          input: envelope,
          trigger: "event",
          event: { event: envelope.event, eventId: envelope.id },
          depth: context.depth + (context.sourceAutomationId ? 1 : 0),
          // The same occurrence never starts this automation twice, even if it's seen again.
          claim: (runId) =>
            store.claimRequestKey({ automationId: id, key: `event:${envelope.id}`, runId, now }),
        });
        if (started.duplicate) return;
        recent.push(ms);
        lastRuns.set(id, started.run.id);
      });

    const deliver = (
      envelope: Envelope,
      subs: ReadonlyArray<Subscription>,
      context: DeliveryContext,
    ) =>
      Effect.gen(function* () {
        const byAutomation = Map.groupBy(subs, (sub) => sub.automation.automation_id);
        for (const [automationId, group] of byAutomation) {
          if (automationId === context.sourceAutomationId || paused.has(automationId)) continue;
          yield* Effect.gen(function* () {
            for (const sub of group) {
              if (!(yield* passes(sub, envelope, context))) continue;
              return yield* start(sub.automation, sub.limit, envelope, context);
            }
          }).pipe(logged(`trigger for ${automationId}`));
        }
      });

    const handleDomain = (item: Extract<Work, { type: "domain" }>) =>
      Effect.gen(function* () {
        const { event } = item;
        const reads: EventReads = {
          shell: yield* Effect.cached(
            threads
              .getThreadShell(ThreadId.make(event.threadId))
              .pipe(Effect.orElseSucceed(() => null)),
          ),
          threads,
        };
        const caused = yield* Effect.cached(automationCaused(event, reads));
        for (const { candidate, subs } of item.hits) {
          yield* Effect.gen(function* () {
            const fields = yield* candidate.build(reads);
            if (fields === null) return;
            const shell = yield* reads.shell;
            const projectId = candidate.projectId ?? shell?.projectId;
            if (!projectId) return;
            const envelope: Envelope = {
              event: candidate.name,
              id: candidate.id,
              at: DateTime.formatIso(event.occurredAt),
              projectId,
              threadId: event.threadId,
              runId: event.runId ?? null,
              threadTitle: shell?.title ?? null,
              ...fields,
            };
            yield* deliver(envelope, subs, {
              actor: candidate.actor,
              fromAutomation: candidate.automationMessage ? Effect.succeed(true) : caused,
              depth: 0,
            });
          }).pipe(logged(candidate.name));
        }
      });

    const worker = Queue.take(work).pipe(
      Effect.flatMap((item) =>
        (item.type === "domain"
          ? handleDomain(item)
          : deliver(item.envelope, item.subs, item.context)
        ).pipe(logged("delivery"), Effect.ensuring(deps.adjustBusy(-1))),
      ),
      Effect.forever,
    );

    return { offer, automationEvent, invalidate, worker };
  });

export type EventTriggers = Effect.Success<ReturnType<typeof makeEventTriggers>>;
