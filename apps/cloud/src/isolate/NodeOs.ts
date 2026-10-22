// @effect-diagnostics nodeBuiltinImport:off - os constants are static; all dynamic identity comes from host input.
import * as NodeBuffer from "node:buffer";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createNodeSystemMetrics } from "./NodeSystemMetrics.ts";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";
import {
  resolveNodeProcessSystemIdentity,
  type NodeProcessHostContext,
  validateNodeRuntimeIdentity,
} from "./node/process/context.ts";
import { unsupportedNodeOperation } from "./node/process/NodeError.ts";

/* Adapted from Rivet agentOS's Node os bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * HOME/TMPDIR override directory values; the shared machine config owns OS identity.
 * Licensed under Apache-2.0; see ./bun/LICENSE.agentos and ./bun/NOTICE.agentos.
 */

function freezeNativeValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeNativeValue));
  if (typeof value !== "object" || value === null) return value;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, freezeNativeValue(nested)]),
    ),
  );
}

const nativeConstants = freezeNativeValue(NodeOS.constants) as typeof NodeOS.constants;

function unsupported(name: string) {
  return markNodeBuiltinCapability(
    (..._args: unknown[]) => unsupportedNodeOperation(`os.${name}`),
    { status: "unsupported", evidence: `NodeOs.${name} has no host capability` },
  );
}

function stripTrailingSeparators(value: string, separator: string): string {
  const root =
    separator === "\\" ? NodePath.win32.parse(value).root : NodePath.posix.parse(value).root;
  let result = value;
  while (result.length > root.length && result.endsWith(separator)) {
    result = result.slice(0, -separator.length);
  }
  return result;
}

function platformType(platform: string): string | undefined {
  const knownTypes: Readonly<Record<string, string>> = {
    aix: "AIX",
    darwin: "Darwin",
    freebsd: "FreeBSD",
    linux: "Linux",
    netbsd: "NetBSD",
    openbsd: "OpenBSD",
    sunos: "SunOS",
    win32: "Windows_NT",
  };
  return knownTypes[platform];
}

function architectureEndianness(arch: string): "BE" | "LE" | undefined {
  const littleEndian = new Set([
    "arm64",
    "ia32",
    "loong64",
    "mipsel",
    "mipsel64",
    "ppc64le",
    "riscv64",
    "x64",
  ]);
  const bigEndian = new Set(["mips", "mips64", "ppc", "ppc64", "s390", "s390x"]);
  if (littleEndian.has(arch)) return "LE";
  if (bigEndian.has(arch)) return "BE";
  return undefined;
}

export function createNodeOs(
  host: Pick<NodeProcessHostContext, "env" | "identity" | "systemIdentity" | "monotonicNowNs">,
) {
  if (!host || !host.env || typeof host.env !== "object") {
    throw new TypeError("Node os requires a host environment");
  }
  validateNodeRuntimeIdentity(host.identity);
  const hasConfiguredSystemIdentity = host.systemIdentity !== undefined;
  const system = resolveNodeProcessSystemIdentity(host);
  const metrics =
    host.monotonicNowNs === undefined
      ? createNodeSystemMetrics(system)
      : createNodeSystemMetrics(system, { readMonotonicTimeNs: host.monotonicNowNs });

  const platform = hasConfiguredSystemIdentity ? system.platform : host.identity.platform;
  const arch = hasConfiguredSystemIdentity ? system.arch : host.identity.arch;
  const isWindows = platform === "win32";
  const separator = isWindows ? "\\" : "/";
  const path = isWindows ? NodePath.win32 : NodePath.posix;

  const os = {
    arch: () => arch,
    platform: () => platform,
    homedir: () => host.env.HOME || host.identity.homedir,
    tmpdir: () => {
      const directory = host.env.TMPDIR || host.env.TMP || host.env.TEMP || host.identity.tmpdir;
      return stripTrailingSeparators(path.normalize(directory), separator);
    },
    EOL: isWindows ? "\r\n" : "\n",
    devNull: isWindows ? "\\\\.\\nul" : "/dev/null",
    constants: nativeConstants,
    type: () => {
      if (hasConfiguredSystemIdentity) return system.type;
      if (host.identity.type) return host.identity.type;
      const type = platformType(platform);
      return type ?? unsupportedNodeOperation("os.type");
    },
    release: () => (platform === "linux" ? system.release : unsupportedNodeOperation("os.release")),
    version: () => (platform === "linux" ? system.version : unsupportedNodeOperation("os.version")),
    hostname: () => system.hostname,
    userInfo: (options?: { readonly encoding?: BufferEncoding | "buffer" }) => {
      const user = host.identity.user;
      if (!user) return unsupportedNodeOperation("os.userInfo");
      const encoding = options?.encoding ?? "utf8";
      if (encoding !== "buffer" && !NodeBuffer.Buffer.isEncoding(encoding)) {
        throw new TypeError(`Unsupported os.userInfo encoding: ${encoding}`);
      }
      const encode = (value: string) => {
        const bytes = NodeBuffer.Buffer.from(value);
        return encoding === "buffer" ? bytes : bytes.toString(encoding);
      };
      return {
        username: encode(user.username),
        uid: user.uid,
        gid: user.gid,
        shell: user.shell === null ? null : encode(user.shell),
        homedir: encode(host.identity.homedir),
      };
    },
    endianness: () => {
      const endianness =
        (hasConfiguredSystemIdentity ? system.endianness : undefined) ??
        host.identity.endianness ??
        architectureEndianness(arch);
      return endianness ?? unsupportedNodeOperation("os.endianness");
    },
    machine: () => {
      if (hasConfiguredSystemIdentity) return system.machine;
      if (arch === "x64") return "x86_64";
      if (arch === "arm64") return "aarch64";
      return unsupportedNodeOperation("os.machine");
    },
    cpus: metrics.cpus,
    availableParallelism: () => metrics.availableParallelism,
    loadavg: metrics.loadavg,
    uptime: metrics.uptime,
    freemem: () => metrics.freeMemoryBytes,
    totalmem: () => metrics.totalMemoryBytes,
    networkInterfaces: metrics.networkInterfaces,
    getPriority: unsupported("getPriority"),
    setPriority: unsupported("setPriority"),
  };
  const availability: Readonly<Record<string, boolean>> = {
    type:
      hasConfiguredSystemIdentity || !!host.identity.type || platformType(platform) !== undefined,
    release: platform === "linux",
    version: platform === "linux",
    userInfo: host.identity.user !== undefined,
    endianness:
      hasConfiguredSystemIdentity ||
      host.identity.endianness !== undefined ||
      architectureEndianness(arch) !== undefined,
    machine: hasConfiguredSystemIdentity || arch === "x64" || arch === "arm64",
  };
  for (const name of [
    "arch",
    "platform",
    "homedir",
    "tmpdir",
    "type",
    "release",
    "version",
    "hostname",
    "userInfo",
    "endianness",
    "machine",
  ] as const) {
    markNodeBuiltinCapability(os[name], {
      status: availability[name] === false ? "conditional" : "supported",
      evidence: `NodeOs.${name} uses explicit host identity and environment`,
    });
  }
  for (const name of [
    "availableParallelism",
    "cpus",
    "loadavg",
    "uptime",
    "freemem",
    "totalmem",
    "networkInterfaces",
  ] as const) {
    markNodeBuiltinCapability(os[name], {
      status: "supported",
      evidence: `NodeOs.${name} uses modeled values from shared per-thread system identity`,
    });
  }
  return Object.freeze(os);
}

export default createNodeOs;
