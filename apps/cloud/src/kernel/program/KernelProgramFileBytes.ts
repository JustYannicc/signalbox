import type { KernelHandle } from "../KernelAbi.ts";
import type { KernelFileByteSelection } from "../KernelFileBytes.ts";
import type { KernelFileSystem } from "../KernelFileSystem.ts";
import type { WasiDescriptor } from "../wasi/internal_wasi_descriptors.ts";

export type KernelProgramFileByteSelector = (input: {
  readonly executable: string;
  readonly filesystem: KernelFileSystem;
  readonly parent?: KernelHandle<"process">;
}) => KernelFileByteSelection;

export interface KernelPreparedFileByteSelection {
  readonly executable?: string;
  readonly selection: KernelFileByteSelection;
}

interface ResolveKernelProgramFileBytesInput {
  readonly executable?: string;
  readonly explicitSelection?: KernelFileByteSelection;
  readonly selector?: KernelProgramFileByteSelector;
  readonly filesystem: KernelFileSystem;
  readonly parent?: KernelHandle<"process">;
  readonly hasOpenActions?: boolean;
}

export function resolveKernelProgramFileBytes({
  executable,
  explicitSelection,
  selector,
  filesystem,
  parent,
}: ResolveKernelProgramFileBytesInput): KernelFileByteSelection {
  if (explicitSelection !== undefined) return explicitSelection;
  if (executable === undefined || selector === undefined) return filesystem.fileBytes;
  return selector({ executable, filesystem, ...(parent === undefined ? {} : { parent }) });
}

export function prepareKernelProgramFileBytes(
  input: ResolveKernelProgramFileBytesInput,
): KernelPreparedFileByteSelection | undefined {
  if (
    input.executable === undefined &&
    input.hasOpenActions &&
    input.explicitSelection === undefined &&
    input.selector !== undefined
  ) {
    throw Object.assign(
      new Error("An executable is required before applying open actions with a file selector"),
      { code: "ENOTSUP" },
    );
  }
  if (input.executable === undefined && input.explicitSelection === undefined) return undefined;
  return {
    ...(input.executable === undefined ? {} : { executable: input.executable }),
    selection: resolveKernelProgramFileBytes(input),
  };
}

export function assertKernelFileByteSelectionCompatible(
  descriptors: Iterable<[number, WasiDescriptor]>,
  selection: KernelFileByteSelection,
  options: { readonly survivingOnly?: boolean } = {},
): void {
  for (const [, descriptor] of descriptors) {
    if (descriptor.kind !== "file" || (options.survivingOnly && descriptor.closeOnExec)) continue;
    const compatible =
      selection.kind === "canonical"
        ? descriptor.byteView === undefined
        : descriptor.byteView === selection.view;
    if (!compatible) {
      throw Object.assign(new Error("A surviving regular descriptor uses a different file view"), {
        code: "ENOTSUP",
      });
    }
  }
}

export function commitKernelProgramFileBytes(
  filesystem: KernelFileSystem,
  selection: KernelFileByteSelection,
): void {
  assertKernelFileByteSelectionCompatible(filesystem.descriptors.entries(), selection);
  filesystem.setFileBytes(selection);
}
