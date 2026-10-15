// @effect-diagnostics globalTimers:off globalDateInEffect:off - a test double for Cloudflare's engine, on its fake clock.
import { AutomationRunner } from "@signalbox/automations/runner/AutomationRunner";
import type { Settlement } from "@signalbox/automations/workflow/hostProtocol";
import {
  defineAutomationRun,
  type AutomationRunEnv,
  type LoadAutomation,
} from "@signalbox/automations/workflow/runtime";
import { FakeWorkflows, payload } from "@signalbox/automations/workflow/testing";
import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "@effect/vitest";

import type * as UserDirectory from "../user/UserDirectory.ts";
import { hostOver } from "./CloudAutomations.ts";

/**
 * Cloudflare Workflows for the memory cloud: each run is an instance of the
 * real runtime (`@signalbox/automations/workflow/runtime`) on `FakeWorkflows`,
 * loading the version's `worker_module` and calling its user object through
 * the same `automationHost` RPC the Dynamic Worker's `HOST` does. Test-only.
 */

class Entrypoint {
  readonly env: AutomationRunEnv;
  constructor(_ctx: unknown, env: AutomationRunEnv) {
    this.env = env;
  }
}

/** `export function load(workflow) {…}` as a function; compiled modules import nothing. */
const loadOf = (source: string): LoadAutomation =>
  // Test-only: the module text is our own compiler's output.
  new Function(`${source.replace(/^export function load\b/m, "function load")}\nreturn load;`)();

interface Instance {
  readonly workflows: FakeWorkflows;
  /** How `run` ended: its value, or what it threw (a failed run throws by design). */
  readonly done: Promise<{ readonly ok: boolean; readonly value: unknown }>;
  terminated: boolean;
}

export const makeMemoryWorkflows = (users: () => UserDirectory.UserDirectory["Service"]) => {
  const instances = new Map<string, Instance>();
  /** How many of the next events the backend refuses, as in an outage. */
  let refusing = 0;
  /** Host calls in flight; `idle` waits for them. */
  const pending = new Set<Promise<unknown>>();

  const hostFor = (userId: string, automationId: string, version: number) =>
    hostOver((request) => {
      const call = Effect.runPromise(
        users()
          .forUser(userId)
          .automationHost({ ...request, automationId, version }),
      );
      pending.add(call);
      void call.finally(() => pending.delete(call)).catch(() => undefined);
      return call;
    });

  const layerFor = (userId: string) =>
    Layer.succeed(
      AutomationRunner,
      AutomationRunner.of({
        create: (run) =>
          Effect.promise(async () => {
            if (instances.has(run.runId)) return;
            const source = await Effect.runPromise(
              users().forUser(userId).automationWorkerModule(run.automationId, run.version),
            );
            const workflows = new FakeWorkflows();
            const AutomationRun = defineAutomationRun(Entrypoint, loadOf(source));
            const entry = new AutomationRun(null, {
              HOST: hostFor(userId, run.automationId, run.version),
            });
            const done = entry
              .run(payload(run.runId, run.input, run.trigger), workflows.step())
              .then(
                (value: unknown) => ({ ok: true, value }),
                (error: unknown) => ({ ok: false, value: error }),
              );
            instances.set(run.runId, { workflows, done, terminated: false });
          }),
        sendEvent: (runId, type, payload) =>
          (refusing > 0
            ? Effect.suspend(() => {
                refusing--;
                return Effect.fail(new AutomationError({ message: "The backend is down." }));
              })
            : Effect.void
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                const instance = instances.get(runId);
                if (instance && !instance.terminated)
                  instance.workflows.sendEvent(type, payload as Settlement);
              }),
            ),
          ),
        terminate: (runId) =>
          Effect.sync(() => {
            const instance = instances.get(runId);
            if (!instance) return;
            instance.terminated = true;
            instance.workflows.evict();
          }),
      }),
    );

  /**
   * Lets every instance run until it's blocked on a sleep or a wait, or done:
   * until no host call is in flight after the instances had a turn to make one.
   */
  const idle = Effect.promise(async () => {
    do {
      await Promise.allSettled(pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (pending.size > 0);
  });

  /** Moves the (faked) clock on, waking every instance's due sleeps and timing out due waits. */
  const advance = (ms: number) =>
    Effect.sync(() => {
      vi.setSystemTime(Date.now() + ms);
      for (const instance of instances.values()) instance.workflows.advance(0);
    }).pipe(Effect.andThen(idle));

  return {
    layerFor,
    idle,
    advance,
    /** The backend refuses the next `count` events. */
    refuseEvents: (count: number) => {
      refusing = count;
    },
    /** Drops a run's instance, as if it was never created. */
    forget: (runId: string) => {
      instances.get(runId)?.workflows.evict();
      instances.delete(runId);
    },
    /** A run's instance: its journal and what it's blocked on. */
    instance: (runId: string) => instances.get(runId),
  };
};
