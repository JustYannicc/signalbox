// @effect-diagnostics nodeBuiltinImport:off - fixtures use private temporary launch files and copied workspace roots.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { RunnerCommandConfigJson } from "@signalbox/runner-protocol/RunnerCommandProtocol";
import { expect } from "vite-plus/test";

import { prepareRunnerCommandCgroup } from "./RunnerCommandCgroup.ts";
import {
  loadRunnerCommandConfig,
  readRunnerCommandReceipt,
  verifyRunnerCommandWorkspace,
} from "./RunnerCommandBootstrap.ts";

const withFixture = (
  run: (input: {
    readonly root: string;
    readonly workspace: string;
    readonly configPath: string;
    readonly receiptPath: string;
    readonly workspaceSystem: {
      readonly realpath: (path: string) => string;
      readonly isDirectory: (path: string) => boolean;
    };
  }) => void,
) => {
  const root = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runner-command-bootstrap-")),
  );
  const workspace = NodePath.join(root, "workspace");
  const runDirectory = NodePath.join(root, "run");
  const configPath = NodePath.join(runDirectory, "runner.json");
  const receiptPath = NodePath.join(runDirectory, "workspace-receipt.json");
  NodeFS.mkdirSync(workspace);
  NodeFS.mkdirSync(runDirectory);
  const toDiskPath = (path: string) =>
    path === "/workspace"
      ? workspace
      : path.startsWith("/workspace/")
        ? NodePath.join(workspace, path.slice("/workspace/".length))
        : path;
  const workspaceSystem = {
    // This fake filesystem maps the contract path to the copied fixture; it does not prove a mounted /workspace.
    realpath(path: string) {
      if (path === "/workspace" || path === workspace) return "/workspace";
      if (path.startsWith("/workspace/")) return NodeFS.realpathSync.native(toDiskPath(path));
      if (path.startsWith(`${workspace}/`)) return `/workspace${path.slice(workspace.length)}`;
      return NodeFS.realpathSync.native(path);
    },
    isDirectory(path: string) {
      return NodeFS.statSync(toDiskPath(path)).isDirectory();
    },
  };
  try {
    run({ root, workspace, configPath, receiptPath, workspaceSystem });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

const configJson = (receiptPath: string, cgroupPath?: string) =>
  JSON.stringify({
    version: 1,
    endpoint: "wss://cloud.example/api/computer/runner",
    threadId: "thread-command-1",
    operationId: "operation-1",
    machineId: "machine-1",
    generation: 3,
    token: "launch-secret",
    workspaceReceipt: receiptPath,
    ...(cgroupPath === undefined ? {} : { cgroupPath }),
  });

const receiptJson = (overrides: Readonly<Record<string, unknown>> = {}) =>
  JSON.stringify({
    version: 1,
    threadId: "thread-command-1",
    operationId: "operation-1",
    machineId: "machine-1",
    generation: 3,
    root: "/workspace",
    ...overrides,
  });

const writePrivateConfig = (path: string, contents: string) => {
  NodeFS.writeFileSync(path, contents, { mode: 0o600 });
  NodeFS.chmodSync(path, 0o600);
};

it("attests a canonical command cwd only while launch config and owner receipt still match", () => {
  withFixture(({ configPath, receiptPath, workspaceSystem }) => {
    writePrivateConfig(configPath, configJson(receiptPath));
    NodeFS.writeFileSync(receiptPath, receiptJson(), { mode: 0o600 });

    const config = loadRunnerCommandConfig(configPath, workspaceSystem);
    const receipt = readRunnerCommandReceipt(receiptPath, workspaceSystem);
    const workspaceAttestation = verifyRunnerCommandWorkspace(
      {
        configPath,
        config,
        expectedReceipt: receipt,
      },
      workspaceSystem,
    );

    expect(
      workspaceAttestation.attestCanonicalCwd({
        threadId: config.threadId,
        generation: config.generation,
        cwd: "/workspace",
      }),
    ).toBe(true);
    expect(
      workspaceAttestation.attestCanonicalCwd({
        threadId: config.threadId,
        generation: config.generation,
        cwd: "/workspace/missing",
      }),
    ).toBe(false);

    NodeFS.writeFileSync(receiptPath, receiptJson({ operationId: "another-operation" }));
    expect(
      workspaceAttestation.attestCanonicalCwd({
        threadId: config.threadId,
        generation: config.generation,
        cwd: "/workspace",
      }),
    ).toBe(false);

    NodeFS.writeFileSync(receiptPath, receiptJson());
    writePrivateConfig(
      configPath,
      configJson(receiptPath).replace('"machineId":"machine-1"', '"machineId":"machine-2"'),
    );
    expect(
      workspaceAttestation.attestCanonicalCwd({
        threadId: config.threadId,
        generation: config.generation,
        cwd: "/workspace",
      }),
    ).toBe(false);
  });
});

it("rejects symlinked, public, and workspace-local config or receipt files", () => {
  withFixture(({ workspace, configPath, receiptPath, workspaceSystem }) => {
    writePrivateConfig(configPath, configJson(receiptPath));
    const configLink = NodePath.join(NodePath.dirname(configPath), "linked-runner.json");
    NodeFS.symlinkSync(configPath, configLink);
    expect(() => loadRunnerCommandConfig(configLink, workspaceSystem)).toThrow();

    NodeFS.chmodSync(configPath, 0o644);
    expect(() => loadRunnerCommandConfig(configPath, workspaceSystem)).toThrow();
    writePrivateConfig(configPath, configJson(receiptPath));

    const localConfig = NodePath.join(workspace, "runner.json");
    writePrivateConfig(localConfig, configJson(receiptPath));
    expect(() => loadRunnerCommandConfig(localConfig, workspaceSystem)).toThrow();

    const localReceipt = NodePath.join(workspace, "receipt.json");
    NodeFS.writeFileSync(localReceipt, receiptJson());
    writePrivateConfig(configPath, configJson(localReceipt));
    expect(() => loadRunnerCommandConfig(configPath, workspaceSystem)).not.toThrow();
    expect(() => readRunnerCommandReceipt(localReceipt, workspaceSystem)).toThrow();

    NodeFS.writeFileSync(receiptPath, receiptJson());
    const receiptLink = NodePath.join(NodePath.dirname(receiptPath), "linked-receipt.json");
    NodeFS.symlinkSync(receiptPath, receiptLink);
    expect(() => readRunnerCommandReceipt(receiptLink, workspaceSystem)).toThrow();
  });
});

it("joins only an exact owner-created cgroup and fails closed when v2 membership cannot be proven", () => {
  const config = RunnerCommandConfigJson.decode(
    configJson(
      "/run/signalbox-command/workspace-receipt.json",
      "/sys/fs/cgroup/signalbox-command/command-1",
    ),
  );
  const calls: Array<string> = [];
  const system = {
    realpath: (path: string) => path,
    readControllers: () => {
      calls.push("controllers");
    },
    moveCurrentProcess: (_path: string, pid: number) => {
      calls.push(`move:${pid}`);
    },
    currentMembership: () => {
      calls.push("membership");
      return "0::/signalbox-command/command-1\n";
    },
    pid: 4242,
  };
  prepareRunnerCommandCgroup(config, system);
  expect(calls).toEqual(["controllers", "move:4242", "membership"]);

  const rejectedSystem = {
    ...system,
    readControllers: () => {
      throw new Error("no v2 controllers file");
    },
    moveCurrentProcess: () => {
      throw new Error("must not move without v2 proof");
    },
  };
  expect(() => prepareRunnerCommandCgroup(config, rejectedSystem)).toThrow(
    "could not verify cgroup v2 membership",
  );

  const wrongGroup = { ...system, currentMembership: () => "0::/signalbox-command/other\n" };
  expect(() => prepareRunnerCommandCgroup(config, wrongGroup)).toThrow(
    "could not verify cgroup v2 membership",
  );
});

it("accepts the command endpoint and one safe cgroup while rejecting alternate routes", () => {
  expect(
    RunnerCommandConfigJson.decode(
      configJson("/run/workspace-receipt.json", "/sys/fs/cgroup/signalbox-command/command-1"),
    ).cgroupPath,
  ).toBe("/sys/fs/cgroup/signalbox-command/command-1");
  const tokenQuery = configJson("/run/workspace-receipt.json").replace(
    "wss://cloud.example/api/computer/runner",
    "wss://cloud.example/api/computer/runner?token=secret",
  );
  expect(() => RunnerCommandConfigJson.decode(tokenQuery)).toThrow();
  for (const cgroupPath of [
    "/sys/fs/cgroup/signalbox-command/command-1/nested",
    "/sys/fs/cgroup/signalbox-command/../command-1",
    "/sys/fs/cgroup",
  ]) {
    expect(() =>
      RunnerCommandConfigJson.decode(configJson("/run/workspace-receipt.json", cgroupPath)),
    ).toThrow();
  }
});
