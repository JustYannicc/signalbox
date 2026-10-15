// @effect-diagnostics globalTimers:off globalDateInEffect:off - a test double for Cloudflare's engine, on its fake clock.
import { AutomationRunner } from "@signalbox/automations/runner/AutomationRunner";
import type { AutomationRunHost, Settlement } from "@signalbox/automations/workflow/hostProtocol";
import {
  defineAutomationRun,
  type AutomationRunEnv,
  type LoadAutomation,
} from "@signalbox/automations/workflow/runtime";
import { FakeWorkflows } from "@signalbox/automations/workflow/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "@effect/vitest";

import type * as UserDirectory from "../user/UserDirectory.ts";

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
  readonly done: Promise<unknown>;
  terminated: boolean;
}

export const makeMemoryWorkflows = (users: () => UserDirectory.UserDirectory["Service"]) => {
  const instances = new Map<string, Instance>();
  /** Host calls in flight, so `idle` knows when every instance is blocked. */
  let calls = 0;

  const hostFor = (userId: string, automationId: string, version: number): AutomationRunHost => {
    const call = async (body: Record<string, unknown>) => {
      calls++;
      try {
        return await Effect.runPromise(
          users()
            .forUser(userId)
            .automationHost({ ...body, automationId, version } as never),
        );
      } finally {
        calls--;
      }
    };
    return {
      step: (runId, request, marks) =>
        call({ method: "step", runId, request, marks }) as ReturnType<AutomationRunHost["step"]>,
      settled: async (runId, key) => {
        await call({ method: "settled", runId, key });
      },
      timedOut: (runId, key) => call({ method: "timedOut", runId, key }) as Promise<Settlement>,
      failed: async (runId, key, error) => {
        await call({ method: "failed", runId, key, error });
      },
      finish: async (runId, end, marks) => {
        await call({ method: "finish", runId, end, marks });
      },
    };
  };

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
              .run(
                { payload: { runId: run.runId, input: run.input, trigger: run.trigger } },
                workflows.step(),
              )
              .catch((error: unknown) => error);
            instances.set(run.runId, { workflows, done, terminated: false });
          }),
        sendEvent: (runId, type, payload) =>
          Effect.sync(() => {
            const instance = instances.get(runId);
            if (instance && !instance.terminated)
              instance.workflows.sendEvent(type, payload as Settlement);
          }),
        terminate: (runId) =>
          Effect.sync(() => {
            const instance = instances.get(runId);
            if (!instance) return;
            instance.terminated = true;
            instance.workflows.evict();
          }),
      }),
    );

  /** Lets every instance run until it's blocked on a sleep or a wait, or done. */
  const idle = Effect.promise(async () => {
    let quiet = 0;
    while (quiet < 5) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      quiet = calls === 0 ? quiet + 1 : 0;
    }
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
    /** A run's instance: its journal and what it's blocked on. */
    instance: (runId: string) => instances.get(runId),
  };
};
