// @effect-diagnostics nodeBuiltinImport:off - native stream types describe host-provided streams; this module does not access a Node host.
import type * as NodeStream from "node:stream";

import type { KernelHandle } from "../../../kernel/KernelAbi.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { KernelProcessTable } from "../../../kernel/KernelProcessTable.ts";

export type NodeProcessEnvironment = Record<string, string | undefined>;
export type NodeProcessFileSystem = Pick<KernelFileSystem, "cwd" | "chdir">;

export interface NodeRuntimeUserIdentity {
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly shell: string | null;
}

export interface NodeRuntimeIdentity {
  readonly version: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly arch: string;
  readonly type?: string;
  readonly endianness?: "BE" | "LE";
  readonly availableParallelism?: number;
  readonly user?: NodeRuntimeUserIdentity;
  readonly homedir: string;
  readonly tmpdir: string;
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly argv0: string;
  readonly argv: readonly string[];
  readonly execArgv?: readonly string[];
  readonly main?: unknown;
}

export interface NodeProcessStreams {
  readonly stdin: NodeStream.Readable;
  readonly stdout: NodeStream.Writable;
  readonly stderr: NodeStream.Writable;
}

export interface NodeProcessHostContext {
  readonly filesystem: NodeProcessFileSystem;
  readonly env: NodeProcessEnvironment;
  readonly identity: NodeRuntimeIdentity;
  readonly streams: NodeProcessStreams;
  readonly processes?: Pick<KernelProcessTable, "signalPid">;
  readonly parentProcessHandle?: KernelHandle<"process">;
}

export function validateNodeRuntimeIdentity(identity: NodeRuntimeIdentity): void {
  if (!identity || typeof identity !== "object") {
    throw new TypeError("Node host identity is required");
  }
  const requiredStrings = [
    ["version", identity.version],
    ["platform", identity.platform],
    ["arch", identity.arch],
    ["homedir", identity.homedir],
    ["tmpdir", identity.tmpdir],
    ["execPath", identity.execPath],
    ["argv0", identity.argv0],
  ] as const;
  for (const [name, value] of requiredStrings) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Node host identity requires a non-empty ${name}`);
    }
  }
  if (
    identity.type !== undefined &&
    (typeof identity.type !== "string" || identity.type.length === 0)
  ) {
    throw new TypeError("Node host identity type must be a non-empty string when supplied");
  }
  if (
    identity.endianness !== undefined &&
    identity.endianness !== "BE" &&
    identity.endianness !== "LE"
  ) {
    throw new TypeError("Node host identity endianness must be BE or LE when supplied");
  }
  if (
    identity.availableParallelism !== undefined &&
    (!Number.isSafeInteger(identity.availableParallelism) || identity.availableParallelism < 1)
  ) {
    throw new TypeError("Node host identity availableParallelism must be a positive safe integer");
  }
  if (identity.user) {
    if (typeof identity.user.username !== "string" || identity.user.username.length === 0) {
      throw new TypeError("Node host identity user requires a username");
    }
    if (!Number.isSafeInteger(identity.user.uid) || identity.user.uid < 0) {
      throw new TypeError("Node host identity user requires a non-negative integer uid");
    }
    if (!Number.isSafeInteger(identity.user.gid) || identity.user.gid < 0) {
      throw new TypeError("Node host identity user requires a non-negative integer gid");
    }
    if (identity.user.shell !== null && typeof identity.user.shell !== "string") {
      throw new TypeError("Node host identity user shell must be a string or null");
    }
  }
  if (!identity.versions || typeof identity.versions !== "object") {
    throw new TypeError("Node host identity requires versions");
  }
  if (typeof identity.versions.node !== "string" || identity.versions.node.length === 0) {
    throw new TypeError("Node host identity requires versions.node");
  }
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1) {
    throw new TypeError("Node host identity requires a positive integer pid");
  }
  if (!Number.isSafeInteger(identity.ppid) || identity.ppid < 0) {
    throw new TypeError("Node host identity requires a non-negative integer ppid");
  }
  if (
    !Array.isArray(identity.argv) ||
    identity.argv.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("Node host identity requires a string argv array");
  }
  if (
    identity.execArgv !== undefined &&
    (!Array.isArray(identity.execArgv) ||
      identity.execArgv.some((argument) => typeof argument !== "string"))
  ) {
    throw new TypeError("Node host identity execArgv must be a string array when supplied");
  }
}

export function validateNodeProcessHost(context: NodeProcessHostContext): void {
  if (!context || typeof context !== "object") throw new TypeError("Node host context is required");
  if (!context.filesystem || typeof context.filesystem.cwd !== "string") {
    throw new TypeError("Node host context requires a filesystem with cwd");
  }
  if (typeof context.filesystem.chdir !== "function") {
    throw new TypeError("Node host context requires filesystem.chdir");
  }
  if (!context.env || typeof context.env !== "object") {
    throw new TypeError("Node host context requires a mutable env object");
  }
  if (
    !context.streams ||
    !context.streams.stdin ||
    !context.streams.stdout ||
    !context.streams.stderr
  ) {
    throw new TypeError("Node host context requires stdin, stdout and stderr streams");
  }
  validateNodeRuntimeIdentity(context.identity);
}
