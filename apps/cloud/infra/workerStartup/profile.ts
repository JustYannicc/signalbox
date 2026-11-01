// @effect-diagnostics nodeBuiltinImport:off - This standalone profiler adapter owns a bounded official Wrangler process and its files.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { requireWorkerdLaunchAdmissionSync } from "../harnessReleases/workerdLaunchAdmission.ts";
import { requireStartupBudget, WORKER_STARTUP_BUDGET_MS } from "./budget.ts";
import { decodeStartupEvidence, startupEvidencePath } from "./evidence.ts";
import { profilerRuntime } from "./runtime.ts";
import { serializeStartupPayload, sha256, startupPayload } from "./payload.ts";
import { readStartupBundle } from "./prebuilt.ts";
import { runStartupProfiler } from "./process.ts";
import { freeBytes } from "./processResources.ts";
import {
  startupProfileLimits as limits,
  startupProfilePaths,
  startupProfilerCommand,
} from "./command.ts";
import { writeStartupInvocation } from "./invocation.ts";

export const StartupProfileInput = Schema.Struct({
  main: Schema.String,
  rules: Schema.Array(Schema.Struct({ globs: Schema.Array(Schema.String) })),
  compatibility: Schema.Struct({ date: Schema.String, flags: Schema.Array(Schema.String) }),
});
const decodeInput = Schema.decodeUnknownSync(StartupProfileInput);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/** One cold profile, no retry. Its final receipt is usable only for the exact prebuilt upload. */
export async function profileWorkerStartup(raw: unknown) {
  const input = decodeInput(raw);
  if (HostProcess.Platform.defaultValue() === "win32")
    throw new Error("WORKER_STARTUP_OWNED_PROCESS_GROUP_REQUIRED");
  requireWorkerdLaunchAdmissionSync();
  const bundle = await readStartupBundle(input, input.compatibility);
  const runtime = await profilerRuntime();
  const serialized = await serializeStartupPayload(bundle, input.compatibility);
  const { output, workerFile, profileFile, ledgerFile, configFile } = startupProfilePaths(
    input.main,
  );
  if (
    (await freeBytes(NodePath.dirname(input.main))) <
    limits.diskFloorBytes + limits.headroomBytes
  )
    throw new Error("WORKER_STARTUP_DISK_HEADROOM");
  // Exclusive creation consumes the attempt even if the profiler fails.
  await NodeFSP.mkdir(output, { mode: 0o700 });
  await NodeFSP.mkdir(NodePath.join(output, "tmp"));
  await NodeFSP.mkdir(NodePath.join(output, "cache"));
  await NodeFSP.writeFile(workerFile, serialized.bytes, { flag: "wx" });
  await NodeFSP.writeFile(
    configFile,
    json({ name: "startup-profile", compatibility_date: input.compatibility.date }),
    { flag: "wx" },
  );
  const command = startupProfilerCommand(runtime, input.main);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "SIGNALBOX_WORKERD_ACTIVE",
        "SIGNALBOX_WORKERD_OWNER",
        "SIGNALBOX_WORKERD_BATCH",
      ].includes(key),
    ),
  );
  Object.assign(environment, {
    SIGNALBOX_STARTUP_WORKERD: runtime.workerdExecutable,
    SIGNALBOX_STARTUP_LEDGER: ledgerFile,
    MINIFLARE_WORKERD_PATH: runtime.workerdExecutable,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: NodePath.join(output, "wrangler.log"),
    TMPDIR: NodePath.join(output, "tmp"),
    XDG_CACHE_HOME: NodePath.join(output, "cache"),
    NO_COLOR: "1",
    CI: "1",
  });
  const { terminal, wallMs, peakRssBytes } = await runStartupProfiler({
    command,
    cwd: NodePath.dirname(input.main),
    env: environment,
    output,
    ledgerFile,
    profileFile,
    limits,
  });
  if (terminal.code !== 0 || terminal.signal !== null)
    throw new Error("WORKER_STARTUP_PROFILER_FAILED");
  const current = await readStartupBundle(input, input.compatibility);
  if (startupPayload(current, input.compatibility).sha256 !== serialized.payload.sha256)
    throw new Error("WORKER_STARTUP_PAYLOAD_CHANGED_DURING_PROFILE");
  const qualified = await qualifyWorkerStartupProfile(input);
  return { ...qualified, wallMs, peakRssBytes };
}

/** Qualify a closed profiler attempt offline; this never starts Wrangler or Workerd. */
export async function qualifyWorkerStartupProfile(raw: unknown) {
  const input = decodeInput(raw);
  const bundle = await readStartupBundle(input, input.compatibility);
  const payload = startupPayload(bundle, input.compatibility);
  const runtime = await profilerRuntime();
  const { profileFile } = startupProfilePaths(input.main);
  const profile = await NodeFSP.readFile(profileFile);
  const summary = requireStartupBudget(JSON.parse(profile.toString("utf8")));
  const destination = `${NodePath.basename(input.main)}.startup.cpuprofile`;
  await NodeFSP.copyFile(
    profileFile,
    NodePath.join(NodePath.dirname(input.main), destination),
    NodeFSP.constants.COPYFILE_EXCL,
  );
  const invocationSha256 = await writeStartupInvocation(
    input.main,
    payload.sha256,
    runtime,
    profile,
  );
  const evidence = decodeStartupEvidence({
    schema: "signalbox/worker-startup-profile/v2",
    status: "passed",
    payloadSha256: payload.sha256,
    invocationSha256,
    budgetMs: WORKER_STARTUP_BUDGET_MS,
    negativeDeltaCount: summary.negativeDeltaCount,
    profileFile: destination,
    profileSha256: sha256(profile),
    runtime: runtime.identity,
    invocation: { wranglerExitCode: 0, workerdStarts: 1, workerdClosed: true, guardPassed: true },
  });
  await NodeFSP.writeFile(startupEvidencePath(input.main), json(evidence), { flag: "wx" });
  return { evidence, summary };
}
