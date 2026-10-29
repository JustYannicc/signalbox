import { clockMillis, isoAt } from "./platform.ts";
import {
  cleanupDeploy3Worker,
  listDeploy3WorkerInventory,
  type Deploy3CleanupResult,
  type Deploy3Observation,
} from "./cloudflare.ts";
import { effectiveDeploy3Deadline, parseDeploy3Name } from "./deadline.ts";
import { deploy3RegistryApi } from "./registryGitHub.ts";
import { runRegisteredDeploy3Backstop } from "./registryCleanup.ts";
import { parseTrustedWriterIds } from "./runtime.ts";

export interface Deploy3SweepOptions {
  readonly accountId: string;
  readonly token: string;
  readonly nowMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly observe?: (event: Deploy3Observation) => void | Promise<void>;
  readonly excludeWorkerNames?: readonly string[];
  readonly reportCleanup?: (cleanup: Deploy3CleanupResult) => Promise<void>;
}

export interface Deploy3SweepEvidence {
  readonly schema: "sb1070/deploy3-github-sweep/v1";
  readonly status: "completed" | "failed-or-uncertain";
  readonly cleanClaim: boolean;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string;
  readonly scannedWorkers: number;
  readonly candidateWorkers: number;
  readonly expiredWorkers: number;
  readonly notDueWorkers: number;
  readonly results: readonly (
    | Deploy3CleanupResult
    | {
        readonly workerName: string;
        readonly status: "refused";
        readonly cleanClaim: false;
        readonly reason: string;
      }
  )[];
  readonly failures: readonly string[];
}

function failure(startedAtUtc: string, nowMs: number, code: string): Deploy3SweepEvidence {
  return {
    schema: "sb1070/deploy3-github-sweep/v1",
    status: "failed-or-uncertain",
    cleanClaim: false,
    startedAtUtc,
    finishedAtUtc: isoAt(nowMs),
    scannedWorkers: 0,
    candidateWorkers: 0,
    expiredWorkers: 0,
    notDueWorkers: 0,
    results: [],
    failures: [code],
  };
}

/** Runs the hourly sweep over one complete Worker inventory snapshot. */
export async function runDeploy3Sweep(options: Deploy3SweepOptions): Promise<Deploy3SweepEvidence> {
  const validNow =
    Number.isSafeInteger(options.nowMs) &&
    options.nowMs >= 0 &&
    options.nowMs <= 8_640_000_000_000_000;
  const startedAtUtc = isoAt(validNow ? options.nowMs : clockMillis());
  if (!validNow) return failure(startedAtUtc, clockMillis(), "invalid-nowMs");

  let workers;
  try {
    workers = await listDeploy3WorkerInventory({
      accountId: options.accountId,
      token: options.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.observe ? { observe: options.observe } : {}),
    });
  } catch {
    return failure(startedAtUtc, clockMillis(), "worker-inventory-incomplete");
  }

  const results: Deploy3SweepEvidence["results"][number][] = [];
  const failures: string[] = [];
  let candidates = 0;
  let expired = 0;
  let notDue = 0;

  for (const worker of workers) {
    if (!worker.id.startsWith("sb1070-d3-") || options.excludeWorkerNames?.includes(worker.id))
      continue;
    candidates += 1;
    const parsed = parseDeploy3Name(worker.id);
    if (!parsed) {
      const reason = "invalid-deploy3-name";
      results.push({ workerName: worker.id, status: "refused", cleanClaim: false, reason });
      failures.push(`${worker.id}:${reason}`);
      continue;
    }
    const deadline = effectiveDeploy3Deadline(worker.id, worker.tags);
    if (!deadline) {
      const reason = "invalid-deploy3-deadline-tags";
      results.push({ workerName: worker.id, status: "refused", cleanClaim: false, reason });
      failures.push(`${worker.id}:${reason}`);
      continue;
    }
    if (options.nowMs < deadline.deadlineMs) {
      notDue += 1;
      results.push({
        schema: "sb1070/deploy3-cloud-cleanup/v1",
        status: "not-due",
        cleanClaim: false,
        workerName: worker.id,
        runId: deadline.runId,
        deadlineUtc: deadline.deadlineUtc,
        assets: "worker-script-managed",
        checks: [{ name: "deadline", status: "passed", detail: deadline.deadlineUtc }],
        failures: [],
        externalBindingsPreserved: [],
      });
      continue;
    }

    expired += 1;
    const cleanup = await cleanupDeploy3Worker({
      ...options,
      workerName: worker.id,
      ...(typeof worker.tag === "string" ? { expectedTag: worker.tag } : {}),
    });
    results.push(cleanup);
    if (cleanup.status !== "not-due" && options.reportCleanup) {
      try {
        await options.reportCleanup(cleanup);
      } catch {
        failures.push(`${worker.id}:public-teardown-receipt-unconfirmed`);
      }
    }
    if (cleanup.status === "not-due") {
      notDue += 1;
    } else if (!cleanup.cleanClaim) {
      failures.push(`${worker.id}:${cleanup.failures.join(",") || cleanup.status}`);
    }
  }

  const finishedAtUtc = isoAt(clockMillis());
  return {
    schema: "sb1070/deploy3-github-sweep/v1",
    status: failures.length === 0 ? "completed" : "failed-or-uncertain",
    cleanClaim: failures.length === 0,
    startedAtUtc,
    finishedAtUtc,
    scannedWorkers: workers.length,
    candidateWorkers: candidates,
    expiredWorkers: expired,
    notDueWorkers: notDue,
    results,
    failures,
  };
}

async function main(): Promise<void> {
  const nowMs = clockMillis();
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  // Failure to read the registry cannot authorize deleting a run with an accepted extension.
  const registry = deploy3RegistryApi({
    token: async () => process.env.GH_TOKEN ?? "",
    trustedWriterIds: parseTrustedWriterIds(process.env.DEPLOY3_CONTROL_WRITER_IDS ?? ""),
  });
  const registered = await runRegisteredDeploy3Backstop({
    registry,
    accountId,
    cloudflareToken: token,
    nowMs,
  });
  const sweep = await runDeploy3Sweep({
    accountId,
    token,
    nowMs,
    excludeWorkerNames: [
      ...registered.controls.map((state) => state.registration.workerName),
      ...registered.bootstraps.map((row) => row.workerName),
    ],
    async reportCleanup() {
      throw new Error(
        "Expired Worker has no durable bootstrap credential record; no final receipt may be published",
      );
    },
  });
  process.stdout.write(
    `Deploy3 sweep ${sweep.status}; ${registered.results.length} registered run(s) checked; evidence not exported\n`,
  );
  if (!registered.cleanClaim || !sweep.cleanClaim) process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch(() => {
    process.stderr.write("Deploy3 sweep or public teardown reporting failed\n");
    process.exitCode = 1;
  });
}
