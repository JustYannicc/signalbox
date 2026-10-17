import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TurnDiagnostics } from "../diagnostics/TurnDiagnostics.ts";
import { ThreadEngine } from "../ThreadEngine.ts";
import { ThreadStore } from "../ThreadStore.ts";
import {
  distinctBackends,
  isStopped,
  MachineBackend,
  type MachineBackendShape,
} from "./MachineBackend.ts";
import type { MachinePlan } from "./ThreadRunner.ts";

/** Backend mutations share the engine lock with purge and recheck the captured plan. */
export const applyMachinePlan = (plan: MachinePlan, threadId: ThreadId, now: number) =>
  Effect.gen(function* () {
    const backends = yield* MachineBackend;
    const engine = yield* ThreadEngine;
    const store = yield* ThreadStore;
    const diagnostics = yield* TurnDiagnostics;
    return yield* engine.apply((projection) =>
      Effect.gen(function* () {
        if (projection === null) return { events: [], result: true };
        const lease = yield* Effect.orDie(store.machine);
        const trash = yield* Effect.orDie(store.currentTrash);
        const ensure = plan.ensure;
        if (
          trash?.purging ||
          trash?.state === "purged" ||
          (ensure === null
            ? lease.status !== "none"
            : lease.generation !== ensure.generation || lease.status === "none")
        )
          return { events: [], result: true };

        const backend = backends[plan.machineClass];
        type Report = Parameters<typeof diagnostics.machineReported>[0];
        let operation: Report["operation"] = ensure === null ? "stop" : "ensure";
        const report = (input: Omit<Report, "generation" | "runId" | "now">) =>
          diagnostics.machineReported({
            ...input,
            generation: ensure?.generation ?? lease.generation,
            runId: plan.runId,
            now,
          });
        const stopAll = (keep: MachineBackendShape | null) =>
          Effect.gen(function* () {
            let stopped = true;
            for (const other of distinctBackends(backends)) {
              if (other === keep) continue;
              const status = yield* other.stop(threadId);
              if (status.actual !== "none") yield* report({ operation: "stop", status });
              stopped = isStopped(status) && stopped;
              if (!stopped) yield* Effect.logInfo("machine not stopped yet", status);
            }
            return stopped;
          });
        const ok = yield* Effect.gen(function* () {
          if (ensure === null) {
            if (plan.lost && plan.release !== null) {
              operation = "inspect";
              const status = yield* backend.inspect(threadId);
              yield* report({ operation, status });
              if (
                status.desired === "running" &&
                (status.actual === "stopped" || status.actual === "stopping")
              )
                yield* diagnostics.refineStop(plan.release, "ttl");
            }
            operation = "stop";
            return yield* stopAll(null);
          }
          operation = "stop";
          if (!(yield* stopAll(backend))) return false;
          operation = "ensure";
          if (lease.saveOnly && backend.kind !== "boat") {
            const existing = yield* backend.inspect(threadId);
            if (existing.actual === "none") {
              yield* report({ operation: "inspect", status: existing });
              return false;
            }
          }
          const status = yield* backend.ensure({
            threadId,
            ...ensure,
            machineClass: plan.machineClass,
            ...(lease.saveOnly ? { saveOnly: true } : {}),
          });
          yield* report({ operation, status });
          if (status.actual !== "running") {
            yield* Effect.logInfo("machine not up yet", status);
            return status.actual !== "failed";
          }
          yield* Effect.orDie(store.saveMachine({ ...lease, ensuredAt: lease.ensuredAt ?? now }));
          return true;
        }).pipe(
          Effect.catchTags({
            MachineBackendError: (error) =>
              Effect.logError("machine request failed", error.message, error.cause).pipe(
                Effect.andThen(report({ operation, error: error.message })),
                Effect.as(false),
              ),
          }),
        );
        return { events: [], result: ok };
      }),
    );
  });
