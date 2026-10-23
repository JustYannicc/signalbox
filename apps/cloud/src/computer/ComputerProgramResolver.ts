import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type { KernelProgramRegistry } from "../kernel/KernelAbi.ts";
import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import type {
  KernelProgramAdmissionRequest,
  KernelProgramAdmissionDecision,
} from "../kernel/KernelProgramAdmission.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import { CHILD_PROGRAM_PATHS } from "./ChildProgramSet.ts";
import { seedComputerProgramFiles } from "./ComputerProgramFiles.ts";
import { COMPUTER_ISOLATE_POLICY } from "./EscalationPolicy.ts";
import {
  snapshotMachinePrograms,
  type MachineProgramInventory,
} from "./MachineProgramInventory.ts";

/** One Computer owns both its filesystem discovery entries and its exec lookup. */
export class ComputerProgramResolver {
  readonly #inventory: MachineProgramInventory;
  readonly #local = new Map<string, string>(
    Object.values(CHILD_PROGRAM_PATHS).map((path) => [path, path]),
  );

  constructor(filesystem: KernelFileSystem, inventory: MachineProgramInventory) {
    this.#inventory = snapshotMachinePrograms(inventory);
    for (const entry of this.#inventory.entries) {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      const local = Object.entries(CHILD_PROGRAM_PATHS).find(([command]) => command === name)?.[1];
      if (local !== undefined) this.#local.set(entry.path, local);
    }
    seedComputerProgramFiles(filesystem, this.#inventory, this.#local);
  }

  get policy() {
    return {
      ...COMPUTER_ISOLATE_POLICY,
      isolateExecutables: [
        ...new Set([...COMPUTER_ISOLATE_POLICY.isolateExecutables, ...this.#local.keys()]),
      ],
    };
  }

  localCommand(command: KernelCommand): KernelCommand {
    const executable = this.#local.get(command.executable);
    return executable === undefined ? command : { ...command, executable };
  }

  bindings(registry: KernelProgramRegistry, bindings: Map<string, KernelProgramBinding>) {
    for (const [path, local] of this.#local) {
      if (bindings.has(path)) continue;
      const binding = bindings.get(local);
      if (binding === undefined) continue;
      const manifest = Object.freeze({
        ...binding.manifest,
        name: `${binding.manifest.name}:path:${path}`,
      });
      const result = registry.register(manifest);
      if (result.status !== "ok") throw new Error(`Could not register catalog path: ${path}`);
      bindings.set(path, { manifest, implementation: binding.implementation });
    }
    return bindings;
  }

  admit(
    request: KernelProgramAdmissionRequest,
    admit: (input: KernelProgramAdmissionRequest) => Promise<KernelProgramAdmissionDecision>,
  ) {
    // Explicit local bindings keep their existing semantics, including direct calls without PATH.
    if (request.target.kind === "resolved") return admit(request);
    const command = request.command;
    const paths = command.executable.includes("/")
      ? [command.executable]
      : (command.env.PATH ?? this.#inventory.path.join(":"))
          .split(":")
          .map((directory) => `${directory || command.cwd}/${command.executable}`);
    let denied = false;
    for (const path of paths) {
      const absolute = path.startsWith("/") ? path : `${command.cwd}/${path}`;
      try {
        if (request.filesystem.stat(absolute).type !== "file") continue;
        request.filesystem.access(absolute, 1, true);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
          if (error.code === "EACCES") {
            denied = true;
            continue;
          }
        }
        throw error;
      }
      return admit({ ...request, command: { ...command, executable: absolute } });
    }
    throw new KernelProgramExecAdmissionError(
      denied ? "EACCES" : "ENOENT",
      `Command ${denied ? "is not executable" : "not found"}: ${command.executable}`,
    );
  }
}
