import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type { KernelProgramAdmissionRequest } from "../kernel/KernelProgramAdmission.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import { CHILD_PROGRAM_PATHS } from "./ChildProgramSet.ts";
import type { ComputerProgramResolution } from "./ComputerProgramAdmission.ts";

const catalogPaths = new Map<string, string>(Object.entries(CHILD_PROGRAM_PATHS));

export interface ComputerProgramResolverOptions {
  readonly path: readonly string[];
  readonly overlay: {
    readonly prepare: (paths: readonly string[], signal?: AbortSignal) => Promise<void>;
    readonly isLower: (path: string, signal?: AbortSignal) => Promise<boolean>;
  };
}

export type ComputerProgramResolverRequest = KernelProgramAdmissionRequest & {
  readonly catalog: ReadonlyMap<string, KernelProgramBinding>;
};

/** Discovery and admission resolve through the same upper-first namespace. */
export class ComputerProgramResolver {
  readonly #options: ComputerProgramResolverOptions;

  constructor(options: ComputerProgramResolverOptions) {
    this.#options = options;
  }

  readonly resolve = async (
    request: ComputerProgramResolverRequest,
  ): Promise<ComputerProgramResolution> => {
    const command = request.command;
    if (request.target.kind === "resolved") return { command };
    const paths = command.executable.includes("/")
      ? [absolutePath(command.executable, command.cwd)]
      : (command.env.PATH ?? this.#options.path.join(":"))
          .split(":")
          .map((directory) =>
            absolutePath(`${directory || command.cwd}/${command.executable}`, command.cwd),
          );
    request.signal.throwIfAborted();
    let denied = false;
    for (const path of paths) {
      let lower: boolean;
      try {
        await this.#options.overlay.prepare([path], request.signal);
        lower = await this.#options.overlay.isLower(path, request.signal);
        if ((await request.filesystem.checkExecutable(path, request.signal)).type !== "file")
          continue;
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        if (code === "EACCES") {
          denied = true;
          continue;
        }
        throw error;
      }
      const resolved = { ...command, executable: path };
      const name = path.slice(path.lastIndexOf("/") + 1);
      const catalog = catalogPaths.get(name);
      const binding = catalog === undefined ? undefined : request.catalog.get(catalog);
      if (lower && catalog !== undefined && binding !== undefined) {
        return {
          command: resolved,
          catalog: { command: { ...resolved, executable: catalog }, binding },
        };
      }
      if (!lower) {
        // Bash owns script interpretation after exec reports an unrecognised upper file.
        throw new KernelProgramExecAdmissionError(
          "ENOEXEC",
          `Executable format is unavailable: ${path}`,
        );
      }
      return { command: resolved };
    }
    throw new KernelProgramExecAdmissionError(
      denied ? "EACCES" : "ENOENT",
      `Command ${denied ? "is not executable" : "not found"}: ${command.executable}`,
    );
  };
}

function absolutePath(path: string, cwd: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
