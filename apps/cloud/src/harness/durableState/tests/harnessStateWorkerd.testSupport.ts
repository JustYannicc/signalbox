// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import { createTestHarness } from "wrangler";

export const topologyRunId = "workerd-topology-proof";

export const makeHarness = () =>
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
        },
      },
    ],
  });
