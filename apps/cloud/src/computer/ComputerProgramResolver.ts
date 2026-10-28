import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type { KernelProgramAdmissionRequest } from "../kernel/KernelProgramAdmission.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import { childProgramName } from "./ChildProgramPaths.ts";
import type { ComputerProgramResolution } from "./ComputerProgramAdmission.ts";
import { isCatalogProgramFile } from "./catalog/ProgramFile.ts";

export interface ComputerProgramResolverOptions {
  readonly path: readonly string[];
  readonly overlay: {
    readonly prepare: (paths: readonly string[], signal?: AbortSignal) => Promise<void>;
    readonly isLower: (path: string, signal?: AbortSignal) => Promise<boolean>;
  };
}

export type ComputerProgramResolverRequest = KernelProgramAdmissionRequest & {
  readonly catalog: ReadonlyMap<string, KernelProgramBinding>;
  readonly aliases?: ReadonlySet<string>;
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
    if (request.target.kind === "resolved") {
      if (!command.executable.startsWith("/") || !request.aliases?.has(command.executable))
        return { command };
      try {
        await this.#options.overlay.prepare([command.executable], request.signal);
        const lower = await this.#options.overlay.isLower(command.executable, request.signal);
        const stat = await request.filesystem.checkExecutable(command.executable, request.signal);
        if (
          stat.type === "file" &&
          (lower ||
            (await isCatalogProgramFile(
              request.filesystem,
              command.executable,
              request.target.binding,
              request.signal,
            )))
        )
          return { command };
        return {
          command,
          unavailable: {
            code: stat.type === "file" ? "ENOEXEC" : "EACCES",
            message: `Catalog executable is shadowed: ${command.executable}`,
          },
        };
      } catch (error) {
        const code = errorCode(error);
        // Catalog identities also work without a materialized machine file.
        if (code === "ENOENT" || code === "ENOTDIR") return { command };
        if (code === "EACCES") {
          return {
            command,
            unavailable: { code, message: `Not executable: ${command.executable}` },
          };
        }
        throw error;
      }
    }
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
      const name = childProgramName(path);
      const catalog = [...request.catalog].find(
        ([executable]) => childProgramName(executable) === name,
      );
      if (lower && catalog !== undefined) {
        return {
          command: resolved,
          catalog: { command: { ...resolved, executable: catalog[0] }, binding: catalog[1] },
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
