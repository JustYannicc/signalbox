// @effect-diagnostics nodeBuiltinImport:off - os constants are static; all dynamic identity comes from host input.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";

import type { NodeProcessHostContext } from "./node/process/context.ts";
import { unsupportedNodeOperation } from "./node/process/NodeError.ts";
import { validateNodeRuntimeIdentity } from "./node/process/context.ts";

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
  return (..._args: unknown[]) => unsupportedNodeOperation(`os.${name}`);
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
  host: Pick<NodeProcessHostContext, "env" | "identity" | "systemIdentity">,
) {
  if (!host || !host.env || typeof host.env !== "object") {
    throw new TypeError("Node os requires a host environment");
  }
  validateNodeRuntimeIdentity(host.identity);
  const system = host.systemIdentity;
  const defaultSystem = system ?? systemIdentityForThread(`process-${host.identity.pid}`);

  const platform = system?.platform ?? host.identity.platform;
  const arch = system?.arch ?? host.identity.arch;
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
      if (system) return system.type;
      if (host.identity.type) return host.identity.type;
      const type = platformType(platform);
      return type ?? unsupportedNodeOperation("os.type");
    },
    release: () =>
      platform === "linux" ? defaultSystem.release : unsupportedNodeOperation("os.release"),
    version: () =>
      platform === "linux" ? defaultSystem.version : unsupportedNodeOperation("os.version"),
    hostname: () => defaultSystem.hostname,
    userInfo: (options?: { readonly encoding?: "utf8" | "buffer" }) => {
      const user = host.identity.user;
      if (!user) return unsupportedNodeOperation("os.userInfo");
      if (options?.encoding === "buffer") return unsupportedNodeOperation("os.userInfo(buffer)");
      if (options?.encoding !== undefined && options.encoding !== "utf8") {
        throw new TypeError(`Unsupported os.userInfo encoding: ${options.encoding}`);
      }
      return {
        username: user.username,
        uid: user.uid,
        gid: user.gid,
        shell: user.shell,
        homedir: host.identity.homedir,
      };
    },
    endianness: () => {
      const endianness =
        system?.endianness ?? host.identity.endianness ?? architectureEndianness(arch);
      return endianness ?? unsupportedNodeOperation("os.endianness");
    },
    machine: () => {
      if (system) return system.machine;
      if (arch === "x64") return "x86_64";
      if (arch === "arm64") return "aarch64";
      return unsupportedNodeOperation("os.machine");
    },
    cpus: unsupported("cpus"),
    availableParallelism: () =>
      host.identity.availableParallelism ?? unsupportedNodeOperation("os.availableParallelism"),
    loadavg: unsupported("loadavg"),
    uptime: unsupported("uptime"),
    freemem: unsupported("freemem"),
    totalmem: unsupported("totalmem"),
    networkInterfaces: unsupported("networkInterfaces"),
    getPriority: unsupported("getPriority"),
    setPriority: unsupported("setPriority"),
  };
  return Object.freeze(os);
}

export default createNodeOs;
