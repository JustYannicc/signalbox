// @effect-diagnostics nodeBuiltinImport:off - this Runner boundary joins its owner-created cgroup before connecting.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { RunnerCommandConfig } from "@signalbox/runner-protocol/RunnerCommandProtocol";

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_PARENT = `${CGROUP_ROOT}/signalbox-command`;
const SAFE_CGROUP_PATH = /^\/sys\/fs\/cgroup\/signalbox-command\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})$/;

interface RunnerCommandCgroupSystem {
  readonly realpath: (path: string) => string;
  readonly readControllers: (groupPath: string) => void;
  readonly moveCurrentProcess: (groupPath: string, pid: number) => void;
  readonly currentMembership: () => string;
  readonly pid: number;
}

const cgroupError = () => new Error("Command Runner could not verify cgroup v2 membership.");

const nativeCgroupSystem: RunnerCommandCgroupSystem = {
  realpath: (path) => NodeFS.realpathSync.native(path),
  readControllers: (groupPath) => {
    const rootControllers = NodePath.join(CGROUP_ROOT, "cgroup.controllers");
    const controllersPath = NodePath.join(groupPath, "cgroup.controllers");
    for (const path of [rootControllers, controllersPath]) {
      const stat = NodeFS.lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid cgroup.controllers");
      NodeFS.readFileSync(path, "utf8");
    }
  },
  moveCurrentProcess: (groupPath, pid) => {
    const processPath = NodePath.join(groupPath, "cgroup.procs");
    const stat = NodeFS.lstatSync(processPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid cgroup.procs");
    const noFollow = NodeFS.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") throw new Error("no-follow file access unavailable");
    const descriptor = NodeFS.openSync(processPath, NodeFS.constants.O_WRONLY | noFollow);
    try {
      NodeFS.writeSync(descriptor, String(pid));
    } finally {
      NodeFS.closeSync(descriptor);
    }
  },
  currentMembership: () => NodeFS.readFileSync("/proc/self/cgroup", "utf8"),
  pid: process.pid,
};

/** Joins this Runner to its one owner-created v2 group before it can send hello. */
export const prepareRunnerCommandCgroup = (
  config: RunnerCommandConfig,
  system: RunnerCommandCgroupSystem = nativeCgroupSystem,
) => {
  if (config.cgroupPath === undefined) return;
  const match = SAFE_CGROUP_PATH.exec(config.cgroupPath);
  if (match === null) throw new Error("Command Runner cgroup path is invalid.");
  const expectedPath = `${CGROUP_PARENT}/${match[1]}`;
  try {
    if (
      system.realpath(CGROUP_ROOT) !== CGROUP_ROOT ||
      system.realpath(CGROUP_PARENT) !== CGROUP_PARENT ||
      system.realpath(expectedPath) !== expectedPath
    ) {
      throw new Error("noncanonical cgroup path");
    }
    system.readControllers(expectedPath);
    system.moveCurrentProcess(expectedPath, system.pid);
    const membershipPath = `/signalbox-command/${match[1]}`;
    if (!system.currentMembership().split("\n").includes(`0::${membershipPath}`)) {
      throw new Error("process did not join cgroup");
    }
    if (system.realpath(expectedPath) !== expectedPath) throw new Error("cgroup path changed");
  } catch {
    throw cgroupError();
  }
};
