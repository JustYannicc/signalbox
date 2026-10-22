// @effect-diagnostics nodeBuiltinImport:off - command bootstrap uses Node's native OS data and sets the Linux machine hostname before accepting commands.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import {
  DEFAULT_SYSTEM_IDENTITY,
  systemIdentityForThread,
  type SystemIdentity,
} from "@t3tools/contracts/systemIdentity";

export interface RunnerCommandSystemIdentitySystem {
  readonly platform: () => string;
  readonly type: () => string;
  readonly arch: () => string;
  readonly machine: () => string;
  readonly endianness: () => string;
  readonly release: () => string;
  readonly version: () => string;
  readonly hostname: () => string;
  readonly setHostname: (hostname: string) => void;
}

const nativeSystem = Object.freeze({
  type: () => NodeOS.type(),
  machine: () => NodeOS.machine(),
  endianness: () => NodeOS.endianness(),
  release: () => NodeOS.release(),
  version: () => NodeOS.version(),
  hostname: () => NodeOS.hostname(),
  setHostname: (hostname: string) => {
    NodeChildProcess.execFileSync("hostname", [hostname], { stdio: "ignore" });
    // Keep programs that read the inherited environment consistent with the kernel name.
    process.env.HOSTNAME = hostname;
  },
});

export function runnerCommandSystemIdentitySystem(
  platform: string,
  arch: string,
): RunnerCommandSystemIdentitySystem {
  return Object.freeze({
    ...nativeSystem,
    platform: () => platform,
    arch: () => arch,
  });
}

export function sameSystemIdentity(left?: SystemIdentity, right?: SystemIdentity): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.release === right.release &&
        left.version === right.version &&
        left.machine === right.machine &&
        left.hostnamePolicy === right.hostnamePolicy &&
        left.verification === right.verification &&
        left.hostname === right.hostname &&
        left.platform === right.platform &&
        left.type === right.type &&
        left.arch === right.arch &&
        left.endianness === right.endianness;
}

/** Resolve legacy launch files through the same shared defaults as the isolate tier. */
export function resolveRunnerCommandSystemIdentity(
  threadId: string,
  configured?: SystemIdentity,
): SystemIdentity {
  const resolved = systemIdentityForThread(threadId, configured ?? DEFAULT_SYSTEM_IDENTITY);
  if (configured && !sameSystemIdentity(configured, resolved)) {
    throw new Error("Command Runner system identity does not match its thread");
  }
  return resolved;
}

/** Verify native machine facts, set the kernel hostname, then verify the visible result. */
export function applyRunnerCommandSystemIdentity(
  identity: SystemIdentity,
  system: RunnerCommandSystemIdentitySystem,
): SystemIdentity {
  if (
    system.platform() !== identity.platform ||
    system.type() !== identity.type ||
    system.arch() !== identity.arch ||
    system.machine() !== identity.machine ||
    system.endianness() !== identity.endianness
  ) {
    throw new Error(
      "Command Runner host platform identity does not match its private configuration",
    );
  }
  if (
    identity.verification === "measured" &&
    (system.release() !== identity.release || system.version() !== identity.version)
  ) {
    throw new Error(
      "Command Runner host release or version does not match its measured configuration",
    );
  }

  system.setHostname(identity.hostname);
  if (system.hostname() !== identity.hostname) {
    throw new Error("Command Runner host hostname does not match its thread identity");
  }
  return identity;
}
