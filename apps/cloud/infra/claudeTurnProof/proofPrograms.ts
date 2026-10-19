import type { KernelCpuAccounting } from "../../src/kernel/KernelCpuAccounting.ts";
import { ABI_VERSION, KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import {
  KernelProgramHost,
  type KernelProgramBinding,
} from "../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import {
  KERNEL_BASH_ARTIFACT,
  createKernelBashProgram,
} from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { registerKernelBusyboxCat } from "../../src/kernel/KernelBusyboxPrograms.ts";
import {
  createKernelRipgrepProgram,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
} from "../../src/kernel/KernelRipgrepProgram.ts";

export interface ProofProgramModules {
  readonly bash: WebAssembly.Module;
  readonly busybox: WebAssembly.Module;
  readonly ripgrep: WebAssembly.Module;
  readonly busyboxCatBase64: string;
}

/** Creates local-only executable bindings over the proof's existing filesystem and wake registry. */
export function createProofProgramHost(options: {
  readonly filesystem: KernelFileSystem;
  readonly wakes: KernelWakeRegistry;
  readonly modules?: ProofProgramModules;
  readonly cpuAccounting: KernelCpuAccounting;
}) {
  const registry = new KernelProgramRegistry();
  if (options.modules === undefined) {
    return new KernelProgramHost({
      registry,
      wakes: options.wakes,
      cpuAccounting: options.cpuAccounting,
    });
  }

  installBusyboxCat(options.filesystem, options.modules.busyboxCatBase64);
  const programs = new Map(registerKernelBusyboxCat(registry, options.modules.busybox));
  const bashManifest = Object.freeze({
    name: "@nimbus/bash",
    version: KERNEL_BASH_ARTIFACT.version,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([
      "process.spawn",
      "process.wait",
      "process.signal",
    ] as const),
    entrypoint: `nimbus-bash:${KERNEL_BASH_ARTIFACT.sha256}`,
  });
  register(registry, bashManifest.name, bashManifest);
  const posix = options.filesystem.posixPolicy;
  if (posix === undefined) throw new Error("Bash requires the canonical filesystem POSIX policy");
  const credentials = posix.credentials;
  const bashCredentials = {
    uid: credentials.uid,
    gid: credentials.gid,
    euid: credentials.euid,
    egid: credentials.egid,
    umask: posix.umask,
    hostname: "signalbox-proof",
  };
  programs.set("/bin/bash", {
    manifest: bashManifest,
    implementation: createKernelBashProgram({
      module: options.modules.bash,
      credentials: bashCredentials,
    }),
  });

  register(registry, KERNEL_RIPGREP_PROGRAM_MANIFEST.name, KERNEL_RIPGREP_PROGRAM_MANIFEST);
  programs.set("/bin/rg", {
    manifest: KERNEL_RIPGREP_PROGRAM_MANIFEST,
    implementation: createKernelRipgrepProgram({ module: options.modules.ripgrep }),
  });
  return new KernelProgramHost({
    registry,
    wakes: options.wakes,
    programs,
    cpuAccounting: options.cpuAccounting,
  });
}

function register(
  registry: KernelProgramRegistry,
  name: string,
  manifest: KernelProgramBinding["manifest"],
): void {
  const result = registry.register(manifest);
  if (result.status !== "ok") {
    const detail = result.status === "error" ? result.error.message : "registration blocked";
    throw new Error(`Could not register ${name}: ${detail}`);
  }
}

function installBusyboxCat(filesystem: KernelFileSystem, base64: string): void {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("BusyBox cat bytes are not valid base64 text");
  }
  const decoded = atob(base64);
  const expected = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (expected.byteLength !== KERNEL_BUSYBOX_ARTIFACT.bytes) {
    throw new Error("BusyBox cat bytes differ from the pinned artifact length");
  }
  assertInstalledCat(filesystem, expected);
}

function assertInstalledCat(filesystem: KernelFileSystem, expected: Uint8Array): void {
  const fd = filesystem.open("/bin/cat", KernelOpenFlags.O_RDONLY);
  let actual: Uint8Array;
  try {
    const size = Number(filesystem.fstat(fd).size);
    actual = new Uint8Array(size);
    let offset = 0;
    while (offset < actual.byteLength) {
      const read = filesystem.read(fd, actual.subarray(offset), null);
      if (read === 0) break;
      offset += read;
    }
    actual = actual.subarray(0, offset);
  } finally {
    filesystem.close(fd);
  }
  if (!equalBytes(actual, expected))
    throw new Error("Existing /bin/cat is not the pinned BusyBox artifact");
  const metadata = filesystem.getPosixMetadata("/bin/cat");
  if ((metadata.mode & 0o777) !== 0o755)
    throw new Error("Pinned /bin/cat is not executable mode 0755");
  const credentials = filesystem.posixCredentials;
  if (
    credentials === undefined ||
    metadata.uid !== credentials.euid ||
    metadata.gid !== credentials.egid
  ) {
    throw new Error("Pinned /bin/cat owner differs from the canonical filesystem policy");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
