// @effect-diagnostics globalFetch:off - private provider adapters perform the real SDK setup and closure calls.
import * as Schema from "effect/Schema";
import {
  RunnerCommandConfigJson,
  RunnerCommandReceiptJson,
  type RunnerCommandConfig,
} from "@signalbox/runner-protocol/RunnerCommandProtocol";
import { boxdMachineClient } from "../../src/computer/BoxdMachines.ts";
import type { MachineRunnerOwner } from "../../src/computer/RunnerMachineRuntime.ts";
import type { BoxdProofVmPort } from "./Workspace.ts";
import { BOXD_PROOF_LAUNCH_FENCE } from "./LaunchFence.ts";
import {
  runSourceStep,
  sourcePreparationCommandFailure,
  type SourcePreparationReporter,
} from "./SourcePreparation.ts";

const session = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }));
const closure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      closed: Schema.Literal(true),
      populated: Schema.Literal(0),
      launchFenced: Schema.Literal(true),
    }),
  ),
);
const launched = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      launched: Schema.Literal(true),
      joined: Schema.Literal(true),
    }),
  ),
);
const RUN_ROOT = "/run/signalbox-command";
const ARTIFACT = "/opt/signalbox-command/command-runner.mjs";
export const WORKSPACE_RECEIPT = `${RUN_ROOT}/workspace.json`;
const CONFIG = `${RUN_ROOT}/runner.json`;

export interface ProofProviderSdkPort {
  readonly machines: {
    readonly exec: (
      id: string,
      input: { readonly command: string[]; readonly timeout: number; readonly cwd?: string },
    ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
    readonly files: {
      readonly upload: (id: string, path: string, bytes: Uint8Array) => Promise<number>;
      readonly download: (id: string, path: string) => Promise<Uint8Array>;
    };
  };
}

export async function openProofProvider(apiKey: string) {
  const response = await fetch("https://app.boxd.sh/api/v1/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Private boxd token exchange failed");
  }
  return boxdMachineClient(session(await response.json()).token);
}

/** Setup, transfers and closure only. The tested user command goes through the Runner socket. */
export function proofProvider(client: ProofProviderSdkPort, owner: string) {
  const python = async (
    id: string,
    args: readonly string[],
    signal: AbortSignal,
    cwd?: string,
    diagnoseSourceFailure = false,
  ) => {
    signal.throwIfAborted();
    const result = await client.machines.exec(id, {
      command: ["sudo", "-n", "/usr/bin/python3", ...args],
      timeout: 30_000,
      ...(cwd === undefined ? {} : { cwd }),
    });
    signal.throwIfAborted();
    if (result.exitCode !== 0) {
      throw diagnoseSourceFailure
        ? sourcePreparationCommandFailure(result.exitCode, result.stderr)
        : new Error("Proof provider setup or closure failed");
    }
    return result;
  };
  const upload = async (id: string, path: string, bytes: Uint8Array, signal: AbortSignal) => {
    signal.throwIfAborted();
    const written = await client.machines.files.upload(id, path, bytes);
    signal.throwIfAborted();
    if (written !== bytes.length) throw new Error("Proof upload was incomplete");
  };
  const vm: BoxdProofVmPort = {
    exec: (id, args, cwd, signal) => python(id, args, signal, cwd),
    upload,
    async download(id, path, signal) {
      signal.throwIfAborted();
      const bytes = await client.machines.files.download(id, path);
      signal.throwIfAborted();
      return bytes;
    },
  };
  const group = (input: MachineRunnerOwner) => {
    const name = `${input.operationId}-g${input.machine.generation}`;
    if (!name.startsWith(`${owner}-command-`) || !/^[a-z0-9-]{1,96}$/.test(name)) {
      throw new Error("Invalid proof command owner");
    }
    return `/sys/fs/cgroup/signalbox-command/${name}`;
  };
  const fence = (input: MachineRunnerOwner) => `${RUN_ROOT}/${group(input).split("/").at(-1)}`;
  return {
    vm,
    cgroupPath: group,
    async prepareSource(
      id: string,
      artifact: Uint8Array,
      signal: AbortSignal,
      reporter?: SourcePreparationReporter,
    ) {
      await runSourceStep(reporter, "directoriesExec", () =>
        python(
          id,
          [
            "-c",
            `import os\nos.makedirs("/opt/signalbox-command", mode=0o755, exist_ok=True)\nos.makedirs(${JSON.stringify(RUN_ROOT)}, mode=0o755, exist_ok=True)`,
          ],
          signal,
          undefined,
          reporter !== undefined,
        ),
      );
      const staging = `/tmp/${owner}-runner.mjs`;
      await runSourceStep(reporter, "runnerUpload", () => upload(id, staging, artifact, signal));
      await runSourceStep(reporter, "installExec", () =>
        python(
          id,
          [
            "-c",
            `import os\nos.replace(${JSON.stringify(staging)}, ${JSON.stringify(ARTIFACT)})\nos.chmod(${JSON.stringify(ARTIFACT)}, 0o644)\nwith open("/opt/signalbox-command/base-marker", "w") as marker:\n    marker.write(${JSON.stringify(owner)})`,
          ],
          signal,
          undefined,
          reporter !== undefined,
        ),
      );
    },
    async assertInheritedSource(id: string, signal: AbortSignal) {
      const result = await python(
        id,
        ["-c", 'print(open("/opt/signalbox-command/base-marker").read(), end="")'],
        signal,
      );
      if (result.stdout !== owner)
        throw new Error("Fork did not inherit the owned warm Base marker");
    },
    async launch(config: RunnerCommandConfig, signal: AbortSignal) {
      const input = {
        operationId: config.operationId,
        machine: { id: config.machineId, generation: config.generation, release: async () => {} },
      };
      const cgroup = group(input);
      if (config.cgroupPath !== cgroup || config.workspaceReceipt !== WORKSPACE_RECEIPT) {
        throw new Error("Runner configuration does not match the owned native paths");
      }
      await this.assertInheritedSource(config.machineId, signal);
      const receipt = RunnerCommandReceiptJson.encode({
        version: 1,
        threadId: config.threadId,
        operationId: config.operationId,
        machineId: config.machineId,
        generation: config.generation,
        root: "/workspace",
      });
      const stagedConfig = `/tmp/${config.operationId}-config.json`;
      const stagedReceipt = `/tmp/${config.operationId}-receipt.json`;
      await upload(
        config.machineId,
        stagedConfig,
        new TextEncoder().encode(RunnerCommandConfigJson.encode(config)),
        signal,
      );
      await upload(config.machineId, stagedReceipt, new TextEncoder().encode(receipt), signal);
      await python(
        config.machineId,
        [
          "-c",
          `import os\nos.makedirs(${JSON.stringify(RUN_ROOT)}, mode=0o755, exist_ok=True)\nos.chmod(${JSON.stringify(stagedConfig)}, 0o600)\nos.replace(${JSON.stringify(stagedConfig)}, ${JSON.stringify(CONFIG)})\nos.replace(${JSON.stringify(stagedReceipt)}, ${JSON.stringify(WORKSPACE_RECEIPT)})`,
        ],
        signal,
      );
      const result = await python(
        config.machineId,
        [
          "-c",
          BOXD_PROOF_LAUNCH_FENCE,
          "launch",
          fence(input),
          cgroup,
          "/usr/local/bin/node",
          ARTIFACT,
          "--config",
          CONFIG,
        ],
        signal,
      );
      launched(result.stdout);
    },
    async quiesce(input: MachineRunnerOwner, signal: AbortSignal) {
      const result = await python(
        input.machine.id,
        ["-c", BOXD_PROOF_LAUNCH_FENCE, "quiesce", fence(input), group(input)],
        signal,
      );
      closure(result.stdout);
      return {
        operationId: input.operationId,
        machineId: input.machine.id,
        generation: input.machine.generation,
        closed: true as const,
      };
    },
  };
}
