import {
  createChildProgramCatalog,
  type ChildProgramCatalogOptions,
} from "../../src/computer/ChildProgramCatalog.ts";
import { KernelOpenFlags, type KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";
import type { ChildProgramSources, ChildProgramSourceCode } from "./prepare.ts";

export interface SeededChildProgramCatalogOptions extends Omit<
  ChildProgramCatalogOptions,
  "programs"
> {
  readonly programs: ChildProgramSources;
}

/** Executables were hashed by the seed route before any program is registered. */
export function createSeededChildProgramCatalog(options: SeededChildProgramCatalogOptions) {
  return createChildProgramCatalog({
    ...options,
    programs: {
      bash: attachProgramBytes(
        options.filesystem,
        "/bin/bash",
        options.programs.bash,
        KERNEL_BASH_ARTIFACT.bytes,
      ),
      busyboxCat: attachProgramBytes(
        options.filesystem,
        "/bin/cat",
        options.programs.busyboxCat,
        KERNEL_BUSYBOX_ARTIFACT.bytes,
      ),
      ripgrep: attachProgramBytes(
        options.filesystem,
        "/bin/rg",
        options.programs.ripgrep,
        KERNEL_RIPGREP_ARTIFACT.bytes,
      ),
    },
  });
}

function attachProgramBytes(
  filesystem: KernelFileSystem,
  path: "/bin/bash" | "/bin/cat" | "/bin/rg",
  code: ChildProgramSourceCode,
  expectedBytes: number,
): ChildWorkerCode {
  if (Object.hasOwn(code.modules, "program.wasm")) {
    throw new Error(`Static child graph already contains program.wasm for ${path}`);
  }
  const wasm = readSeededExecutable(filesystem, path, expectedBytes);
  return Object.freeze({
    ...code,
    modules: Object.freeze({
      ...code.modules,
      "program.wasm": Object.freeze({ wasm }),
    }),
  });
}

function readSeededExecutable(
  filesystem: KernelFileSystem,
  path: "/bin/bash" | "/bin/cat" | "/bin/rg",
  expectedBytes: number,
): ArrayBuffer {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new RangeError(`Invalid expected executable size for ${path}`);
  }
  const descriptor = filesystem.open(path, KernelOpenFlags.O_RDONLY);
  try {
    const fileBytes = Number(filesystem.fstat(descriptor).size);
    if (fileBytes !== expectedBytes) {
      throw new Error(`Seeded executable size differs from the pinned ${path} artifact`);
    }
    const buffer = new ArrayBuffer(expectedBytes);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < expectedBytes) {
      const read = filesystem.read(descriptor, bytes.subarray(offset), null);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== expectedBytes) {
      throw new Error(`Seeded executable read was incomplete for ${path}`);
    }
    return buffer;
  } finally {
    filesystem.close(descriptor);
  }
}
