// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const makeHarness = () =>
  createTestHarness({
    workers: [
      {
        config: {
          name: "harness-durable-state-main",
          main: NodeURL.fileURLToPath(new URL("./harnessStateWorkerd.fixture.ts", import.meta.url)),
          compatibility_date: "2026-10-01",
          durable_objects: {
            bindings: [
              { name: "HARNESS_RUN_STORE", class_name: "HarnessRunStoreObject" },
              { name: "HARNESS_FILES_STORE", class_name: "HarnessFilesStoreObject" },
              { name: "HARNESS_THREAD_SUPERVISOR", class_name: "HarnessThreadSupervisorObject" },
            ],
          },
          migrations: [
            {
              tag: "durable-state-v1",
              new_sqlite_classes: [
                "HarnessRunStoreObject",
                "HarnessFilesStoreObject",
                "HarnessThreadSupervisorObject",
              ],
            },
          ],
          services: [{ binding: "BUSY_WORKER", service: "harness-durable-state-busy" }],
        },
      },
      {
        config: {
          name: "harness-durable-state-busy",
          main: NodeURL.fileURLToPath(new URL("./busyWorkerd.fixture.ts", import.meta.url)),
          compatibility_date: "2026-10-01",
        },
      },
    ],
  });

let harness: ReturnType<typeof makeHarness>;
beforeEach(() => {
  harness = makeHarness();
  return harness.listen();
}, 60_000);
afterEach(() => harness.close());

it("records whether an independent journal read overlaps a fixed CPU loop in a second Worker", async () => {
  const main = harness.getWorker("harness-durable-state-main");
  const initialized = await main.fetch("http://proof/initialize");
  expect(initialized.status).toBe(200);
  await main.evictDurableObject("HarnessRunStoreObject", { name: "workerd-topology-proof" });
  await main.evictDurableObject("HarnessFilesStoreObject", { name: "workerd-topology-proof" });
  await main.evictDurableObject("HarnessThreadSupervisorObject", {
    name: "workerd-topology-proof",
  });
  const recoveredResponse = await main.fetch("http://proof/recover");
  expect(recoveredResponse.status).toBe(200);
  expect(await recoveredResponse.json()).toMatchObject({
    checkpoint: { checkpointId: "workerd-checkpoint-1" },
    file: [{ path: "src/proof.ts", text: "export const proof = true;\n" }],
  });
  const supervisorResponse = await main.fetch("http://proof/supervisor");
  expect(supervisorResponse.status).toBe(200);
  expect(await supervisorResponse.json()).toMatchObject({
    nativeSessionId: "workerd-native-session",
    lifecycle: "accepting",
    checkpoint: { checkpointId: "workerd-checkpoint-1" },
  });

  const busy = main.fetch("http://proof/busy").then(async (response) => {
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      startedAt: number;
      finishedAt: number;
      iterations: number;
      checksum: number;
    }>;
  });
  const journalResponse = await main.fetch("http://proof/journal");
  const journal = (await journalResponse.json()) as {
    startedAt: number;
    completedAt: number;
    result: { snapshot: { seed: { identity: { runId: string } } } };
  };
  const cpu = await busy;
  const completedDuringCpu = journal.completedAt < cpu.finishedAt;
  const observation = {
    topology:
      "three separately bound production DO classes plus a second service-bound Worker; both ingress requests through main",
    cpuDurationMs: cpu.finishedAt - cpu.startedAt,
    cpuIterations: cpu.iterations,
    busyStartedAt: cpu.startedAt,
    journalStartedAt: journal.startedAt,
    journalCompletedAt: journal.completedAt,
    busyFinishedAt: cpu.finishedAt,
    completedDuringCpu,
  };
  const evidenceDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "1396-workerd-journal-proof-"),
  );
  const evidencePath = NodePath.join(evidenceDirectory, "result.json");
  NodeFS.writeFileSync(evidencePath, JSON.stringify(observation, null, 2));

  expect(journal.result.snapshot.seed.identity.runId).toBe("workerd-topology-proof");
  expect(cpu.iterations).toBeGreaterThan(0);
  expect(Number.isInteger(cpu.checksum)).toBe(true);
});
