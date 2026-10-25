// @effect-diagnostics nodeBuiltinImport:off - reads only hash-pinned local WASM artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { createChildBash } from "../../src/computer/ChildBash.ts";
import { createChildBusybox } from "../../src/computer/ChildBusybox.ts";
import { createChildWorkerProgram } from "../../src/computer/ChildWorkerProgram.ts";
import { createKernelBashHost } from "../../src/kernel/KernelBashHost.ts";
import { createKernelBusyboxHost } from "../../src/kernel/KernelBusyboxHost.ts";
import type { KernelBashPort } from "../../src/kernel/KernelBashPort.ts";
import type { KernelBusyboxPort } from "../../src/kernel/KernelBusyboxPort.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_BUSYBOX_VERSION } from "../../src/kernel/KernelBusyboxPrograms.ts";
import { KernelCpuAccounting } from "../../src/kernel/KernelCpuAccounting.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { ABI_VERSION, KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import type { KernelWakeRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import type {
  KernelProgramBinding,
  KernelProgramFileByteSelector,
} from "../../src/kernel/KernelProgramHost.ts";
import type { KernelAsyncProgramContext } from "../../src/kernel/KernelAsyncProgram.ts";

const programDirectory = NodePath.resolve(
  NodeProcess.env.SIGNALBOX_PROOF_PROGRAMS ??
    NodePath.resolve(import.meta.dirname, "../../../../.t3/1071/programs"),
);
const bashPath = NodePath.join(programDirectory, "bash.wasm");
const busyboxPath = NodePath.join(programDirectory, "busybox.wasm");
export const standardProofCommandViewArtifactsAvailable =
  NodeFS.existsSync(bashPath) && NodeFS.existsSync(busyboxPath);
if (
  NodeProcess.env.SIGNALBOX_PROOF_PROGRAMS !== undefined &&
  !standardProofCommandViewArtifactsAvailable
) {
  throw new Error("SIGNALBOX_PROOF_PROGRAMS must contain the pinned bash.wasm and busybox.wasm");
}

function readPinnedModule(path: string, pin: { readonly bytes: number; readonly sha256: string }) {
  const bytes = NodeFS.readFileSync(path);
  if (
    bytes.byteLength !== pin.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  ) {
    throw new Error(`Proof program does not match its pin: ${NodePath.basename(path)}`);
  }
  return new WebAssembly.Module(bytes);
}

const bashModule = standardProofCommandViewArtifactsAvailable
  ? readPinnedModule(bashPath, KERNEL_BASH_ARTIFACT)
  : undefined;
const busyboxModule = standardProofCommandViewArtifactsAvailable
  ? readPinnedModule(busyboxPath, KERNEL_BUSYBOX_ARTIFACT)
  : undefined;

function register(
  registry: KernelProgramRegistry,
  bindings: Map<string, KernelProgramBinding>,
  executable: string,
  manifest: KernelProgramBinding["manifest"],
  implementation: KernelProgramBinding["implementation"],
) {
  const result = registry.register(manifest);
  if (result.status !== "ok") throw new Error(`Could not register ${executable}`);
  bindings.set(executable, { manifest, implementation });
}

function readProofFile(filesystem: KernelFileSystem, path: string) {
  const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const output = new Uint8Array(Number(filesystem.fstat(fd).size));
    const count = filesystem.read(fd, output, null);
    return output.subarray(0, count);
  } finally {
    filesystem.close(fd);
  }
}

export function createStandardProofCommandViewHost(input: {
  readonly filesystem: KernelFileSystem;
  readonly wakes: KernelWakeRegistry;
  readonly selectFileBytes: KernelProgramFileByteSelector;
}) {
  if (bashModule === undefined || busyboxModule === undefined) {
    throw new Error("Pinned Bash and BusyBox programs are unavailable");
  }
  const posix = input.filesystem.posixPolicy;
  if (!posix) throw new Error("Proof filesystem has no POSIX policy");
  const credentials = {
    uid: posix.credentials.uid,
    gid: posix.credentials.gid,
    euid: posix.credentials.euid,
    egid: posix.credentials.egid,
    umask: posix.umask,
    hostname: "signalbox-command-view-proof",
  };
  const capacity = new ChildWorkerCapacity(6);
  const registry = new KernelProgramRegistry();
  const bindings = new Map<string, KernelProgramBinding>();
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
  const bash = createChildWorkerProgram<{ readonly pid: number; readonly port: KernelBashPort }>({
    executable: "/bin/bash",
    code: { mainModule: "bash", modules: {} },
    capacity,
    createHost(context: KernelAsyncProgramContext) {
      const owner = createKernelBashHost({ context, credentials });
      return {
        host: { pid: owner.pid, port: owner.port },
        exited: owner.exited,
        close: owner.close,
      };
    },
    dispatch: {
      async run(input, owner) {
        const process = createChildBash({
          module: bashModule,
          credentials,
          pid: owner.pid,
          port: owner.port,
          args: input.command.argv,
          env: input.command.env,
        });
        try {
          return await process.run();
        } finally {
          await process.drain();
        }
      },
    },
  });
  register(registry, bindings, "/bin/bash", bashManifest, bash);

  const catManifest = Object.freeze({
    name: "@nimbus/busybox/cat",
    version: KERNEL_BUSYBOX_VERSION,
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint: `busybox-${KERNEL_BUSYBOX_VERSION}:cat`,
  });
  const cat = createChildWorkerProgram<KernelBusyboxPort>({
    executable: "/bin/cat",
    code: { mainModule: "busybox-cat", modules: {} },
    capacity,
    createHost(context) {
      const owner = createKernelBusyboxHost({ context });
      return { host: owner.port, close: owner.close };
    },
    dispatch: {
      async run(invocation, port) {
        return await createChildBusybox({
          module: busyboxModule,
          port,
          args: invocation.command.argv,
          env: invocation.command.env,
        }).run();
      },
    },
  });
  register(registry, bindings, "/bin/cat", catManifest, cat);

  const gitManifest = Object.freeze({
    name: "proof/git-file-reader",
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: Object.freeze([]),
    entrypoint: "proof-git-file-reader",
  });
  const gitReadViews: string[] = [];
  register(registry, bindings, "/bin/git", gitManifest, {
    kind: "javascript",
    runInline({ filesystem, args }) {
      gitReadViews.push(filesystem.fileBytes.kind);
      if (filesystem.fileBytes.kind !== "canonical") return 86;
      const path = args.at(-1);
      if (!path) return 2;
      filesystem.write(1, readProofFile(filesystem, path), null);
      return 0;
    },
  });

  let clock = 0n;
  const selectedExecutables: string[] = [];
  const selectFileBytes: KernelProgramFileByteSelector = (request) => {
    selectedExecutables.push(request.executable);
    return input.selectFileBytes(request);
  };
  const host = new KernelProgramHost({
    registry,
    wakes: input.wakes,
    programs: bindings,
    cpuAccounting: new KernelCpuAccounting(() => (clock += 1n)),
    selectFileBytes,
  });
  return { host, capacity, selectedExecutables, gitReadViews };
}
