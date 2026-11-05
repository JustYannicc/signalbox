import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import {
  requireWorkerdLaunchAdmission,
  requireWorkerdLaunchAdmissionSync,
} from "../../../apps/cloud/infra/harnessReleases/workerdLaunchAdmission.ts";
import { useWorkerdAdmissionFixture } from "./workerdAdmission.ts";

useWorkerdAdmissionFixture();

it("admits the test and its inventory child through the fixture slot", async () => {
  await expect(requireWorkerdLaunchAdmission()).resolves.toBeUndefined();
  expect(requireWorkerdLaunchAdmissionSync()).toBeUndefined();
  const admission = new URL(
    "../../../apps/cloud/infra/harnessReleases/workerdLaunchAdmission.ts",
    import.meta.url,
  ).href;
  const child = await NodeUtil.promisify(NodeChildProcess.execFile)(
    NodeProcess.execPath,
    [
      "--input-type=module",
      "-e",
      `const {requireWorkerdLaunchAdmission}=await import(${JSON.stringify(admission)}); await requireWorkerdLaunchAdmission();`,
    ],
    { env: { HOME: NodeProcess.env.HOME, HEAVY_SLOT_ACTIVE: "1" } },
  );
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("");
});

it("keeps the ancestry probe available after profiler sync-spawn lockdown", async () => {
  const admission = new URL(
    "../../../apps/cloud/infra/harnessReleases/workerdLaunchAdmission.ts",
    import.meta.url,
  ).href;
  const child = await NodeUtil.promisify(NodeChildProcess.execFile)(
    NodeProcess.execPath,
    [
      "--input-type=module",
      "-e",
      `const {requireWorkerdLaunchAdmissionSync}=await import(${JSON.stringify(admission)});
const {createRequire,syncBuiltinESMExports}=await import("node:module");
const childProcess=createRequire(import.meta.url)("node:child_process");
childProcess.execFileSync=()=>{throw new Error("WORKER_STARTUP_UNEXPECTED_SYNC_CHILD");};
syncBuiltinESMExports();
requireWorkerdLaunchAdmissionSync();`,
    ],
    { env: { HOME: NodeProcess.env.HOME, HEAVY_SLOT_ACTIVE: "1" } },
  );
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("");
});
