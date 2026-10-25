// @effect-diagnostics nodeBuiltinImport:off - command bootstrap validates mounted files and cgroup membership at the Runner boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePathPosix from "node:path/posix";

import {
  RunnerCommandConfigJson,
  RunnerCommandReceiptJson,
  type RunnerCommandConfig,
  type RunnerCommandReceipt,
} from "@signalbox/runner-protocol/RunnerCommandProtocol";
import { type RunnerBuild } from "@signalbox/runner-protocol/RunnerProtocol";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import packageJson from "../../../package.json" with { type: "json" };
import { prepareRunnerCommandCgroup } from "./RunnerCommandCgroup.ts";
import {
  applyRunnerCommandSystemIdentity,
  resolveRunnerCommandSystemIdentity,
  runnerCommandSystemIdentitySystem,
  sameSystemIdentity,
} from "./RunnerCommandSystemIdentity.ts";
import { runRunnerCommandSession } from "./RunnerCommandSession.ts";
import { webSocketTransport } from "./runnerSocket.ts";
import type { RunnerExecWorkspaceAttestation } from "./RunnerExecHost.ts";

const WORKSPACE_ROOT = "/workspace";
const CONFIG_PRIVATE_MODE = 0o077;

const noFollowFlag = () => {
  const flag = NodeFS.constants.O_NOFOLLOW;
  if (typeof flag !== "number") throw new Error("No-follow file access is unavailable.");
  return flag;
};

interface WorkspacePathSystem {
  readonly realpath: (path: string) => string;
  readonly isDirectory: (path: string) => boolean;
}

const nodeWorkspacePathSystem: WorkspacePathSystem = {
  realpath: (path) => NodeFS.realpathSync.native(path),
  isDirectory: (path) => NodeFS.statSync(path).isDirectory(),
};

const currentWorkspaceRoot = (system: WorkspacePathSystem) => {
  let root: string;
  try {
    root = system.realpath(WORKSPACE_ROOT);
  } catch {
    throw new Error("The command Runner workspace is unavailable.");
  }
  if (root !== WORKSPACE_ROOT || !system.isDirectory(root)) {
    throw new Error("The command Runner workspace mount is not canonical.");
  }
  return root;
};

const isWithin = (root: string, candidate: string) => {
  const relative = NodePathPosix.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith("../"));
};

const assertOutsideWorkspace = (canonicalFilePath: string) => {
  if (isWithin(WORKSPACE_ROOT, canonicalFilePath)) {
    throw new Error("Command Runner config and receipt files must live outside /workspace.");
  }
};

const readRegularFile = (
  filePath: string,
  options: { readonly privateFile: boolean },
  canonicalize: (path: string) => string = (path) => NodeFS.realpathSync.native(path),
): { readonly contents: string; readonly canonicalPath: string } => {
  const absolutePath = NodePath.resolve(filePath);
  let before: NodeFS.Stats;
  let descriptor: number;
  try {
    before = NodeFS.lstatSync(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error("Command Runner config and receipt files must be regular files.");
    }
    descriptor = NodeFS.openSync(absolutePath, NodeFS.constants.O_RDONLY | noFollowFlag());
  } catch {
    throw new Error("Command Runner config or receipt could not be opened safely.");
  }

  try {
    const opened = NodeFS.fstatSync(descriptor);
    const after = NodeFS.lstatSync(absolutePath);
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (options.privateFile && (opened.mode & CONFIG_PRIVATE_MODE) !== 0)
    ) {
      throw new Error("Command Runner config or receipt file permissions are invalid.");
    }
    const contents = NodeFS.readFileSync(descriptor, "utf8");
    const canonicalPath = canonicalize(absolutePath);
    return { contents, canonicalPath };
  } catch {
    throw new Error("Command Runner config or receipt file could not be validated.");
  } finally {
    NodeFS.closeSync(descriptor);
  }
};

const decodeConfigFile = (configPath: string, workspaceSystem: WorkspacePathSystem) => {
  currentWorkspaceRoot(workspaceSystem);
  const file = readRegularFile(configPath, { privateFile: true }, workspaceSystem.realpath);
  assertOutsideWorkspace(file.canonicalPath);
  try {
    return RunnerCommandConfigJson.decode(file.contents);
  } catch {
    throw new Error("Command Runner config is invalid.");
  }
};

export const loadRunnerCommandConfig = (
  configPath: string,
  workspaceSystem: WorkspacePathSystem = nodeWorkspacePathSystem,
): RunnerCommandConfig => decodeConfigFile(configPath, workspaceSystem);

const decodeReceiptFile = (receiptPath: string, workspaceSystem: WorkspacePathSystem) => {
  currentWorkspaceRoot(workspaceSystem);
  const file = readRegularFile(receiptPath, { privateFile: false }, workspaceSystem.realpath);
  assertOutsideWorkspace(file.canonicalPath);
  try {
    return RunnerCommandReceiptJson.decode(file.contents);
  } catch {
    throw new Error("Command Runner workspace receipt is invalid.");
  }
};

export const readRunnerCommandReceipt = (
  receiptPath: string,
  workspaceSystem: WorkspacePathSystem = nodeWorkspacePathSystem,
): RunnerCommandReceipt => decodeReceiptFile(receiptPath, workspaceSystem);

const sameConfig = (left: RunnerCommandConfig, right: RunnerCommandConfig) =>
  left.version === right.version &&
  left.endpoint === right.endpoint &&
  left.threadId === right.threadId &&
  left.operationId === right.operationId &&
  left.machineId === right.machineId &&
  left.generation === right.generation &&
  sameSystemIdentity(left.systemIdentity, right.systemIdentity) &&
  left.token === right.token &&
  left.workspaceReceipt === right.workspaceReceipt &&
  left.cgroupPath === right.cgroupPath;

const sameReceipt = (left: RunnerCommandReceipt, right: RunnerCommandReceipt) =>
  left.version === right.version &&
  left.threadId === right.threadId &&
  left.operationId === right.operationId &&
  left.machineId === right.machineId &&
  left.generation === right.generation &&
  left.root === right.root;

const receiptFor = (config: RunnerCommandConfig): RunnerCommandReceipt => ({
  version: 1,
  threadId: config.threadId,
  operationId: config.operationId,
  machineId: config.machineId,
  generation: config.generation,
  root: WORKSPACE_ROOT,
});

const verifyCurrentWorkspace = (
  configPath: string,
  config: RunnerCommandConfig,
  expectedReceipt: RunnerCommandReceipt,
  cwd: string,
  workspaceSystem: WorkspacePathSystem,
) => {
  if (cwd !== WORKSPACE_ROOT && !cwd.startsWith(`${WORKSPACE_ROOT}/`)) return false;
  if (NodePathPosix.normalize(cwd) !== cwd || cwd.includes("\\") || cwd.includes("\0"))
    return false;
  const currentConfig = decodeConfigFile(configPath, workspaceSystem);
  if (!sameConfig(currentConfig, config)) return false;
  let receipt: RunnerCommandReceipt;
  try {
    receipt = decodeReceiptFile(config.workspaceReceipt, workspaceSystem);
  } catch {
    return false;
  }
  if (!sameReceipt(receipt, expectedReceipt)) return false;
  const root = currentWorkspaceRoot(workspaceSystem);
  if (!isWithin(root, workspaceSystem.realpath(cwd))) return false;
  return workspaceSystem.isDirectory(cwd);
};

/** Creates the synchronous per-command workspace proof consumed by RunnerExecHost. */
export const verifyRunnerCommandWorkspace = (
  input: {
    readonly configPath: string;
    readonly config: RunnerCommandConfig;
    readonly expectedReceipt: RunnerCommandReceipt;
  },
  workspaceSystem: WorkspacePathSystem = nodeWorkspacePathSystem,
): RunnerExecWorkspaceAttestation => {
  const configOnDisk = decodeConfigFile(input.configPath, workspaceSystem);
  if (!sameConfig(configOnDisk, input.config)) {
    throw new Error("Command Runner config changed during bootstrap.");
  }
  const receipt = readRunnerCommandReceipt(input.config.workspaceReceipt, workspaceSystem);
  if (
    !sameReceipt(receipt, input.expectedReceipt) ||
    !sameReceipt(receipt, receiptFor(input.config))
  ) {
    throw new Error("Command Runner workspace receipt does not match this launch.");
  }
  currentWorkspaceRoot(workspaceSystem);
  return {
    attestCanonicalCwd: (candidate) => {
      if (
        candidate.threadId !== input.config.threadId ||
        candidate.generation !== input.config.generation
      ) {
        return false;
      }
      try {
        return verifyCurrentWorkspace(
          input.configPath,
          input.config,
          input.expectedReceipt,
          candidate.cwd,
          workspaceSystem,
        );
      } catch {
        return false;
      }
    },
  };
};

const environmentValue = (name: string) => process.env[name]?.trim() || null;

const runnerBuild: RunnerBuild = {
  imageDigest: environmentValue("SIGNALBOX_RUNNER_IMAGE_DIGEST"),
  revision: environmentValue("SIGNALBOX_RUNNER_REVISION"),
  cliVersions: {},
};

/** Validates the private launch files, enrolls this process, then opens the scoped exec session. */
export const runRunnerCommandBootstrap = Effect.fn("runRunnerCommandBootstrap")(function* (
  configPath: string,
) {
  const config = yield* Effect.sync(() => loadRunnerCommandConfig(configPath));
  const systemIdentity = yield* Effect.sync(() =>
    resolveRunnerCommandSystemIdentity(config.threadId, config.systemIdentity),
  );
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const expectedReceipt = receiptFor(config);
  const workspace = verifyRunnerCommandWorkspace({ configPath, config, expectedReceipt });
  prepareRunnerCommandCgroup(config);
  applyRunnerCommandSystemIdentity(
    systemIdentity,
    runnerCommandSystemIdentitySystem(platform, architecture),
  );
  yield* Effect.scoped(
    runRunnerCommandSession({
      threadId: config.threadId,
      generation: config.generation,
      token: config.token,
      machineId: config.machineId,
      imageVersion:
        environmentValue("SIGNALBOX_RUNNER_IMAGE") ?? packageJson.version ?? "command-runner",
      build: runnerBuild,
      transport: webSocketTransport(config.endpoint),
      workspace,
    }),
  );
});
