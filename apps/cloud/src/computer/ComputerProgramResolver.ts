import { KernelProgramExecAdmissionError } from "../kernel/KernelAsyncProgram.ts";
import type { KernelProgramAdmissionRequest } from "../kernel/KernelProgramAdmission.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";
import type {
  KernelExecutableArtifact,
  KernelExecutableNamespace,
} from "../kernel/KernelExecutableNamespace.ts";
import { childProgramName } from "./ChildProgramPaths.ts";
import type { ComputerProgramResolution } from "./ComputerProgramResolution.ts";

export interface ComputerProgramResolverOptions {
  readonly path: readonly string[];
}

export type ComputerProgramResolverRequest<
  Binding extends { readonly implementation: object } = KernelProgramBinding,
> = Pick<KernelProgramAdmissionRequest, "command" | "signal"> & {
  readonly target:
    | {
        readonly kind: "resolved";
        readonly binding: Binding;
        readonly program?: import("../kernel/KernelAbi.ts").ResolvedProgram;
      }
    | Extract<KernelProgramAdmissionRequest["target"], { readonly kind: "unsupported" }>;
  readonly namespace: KernelExecutableNamespace;
  readonly catalog: ReadonlyMap<string, Binding>;
  readonly aliases?: ReadonlySet<string>;
};

/** Discovery and admission resolve through the same upper-first namespace. */
export class ComputerProgramResolver {
  readonly #options: ComputerProgramResolverOptions;

  constructor(options: ComputerProgramResolverOptions) {
    this.#options = options;
  }

  readonly resolve = async <Binding extends { readonly implementation: object }>(
    request: ComputerProgramResolverRequest<Binding>,
  ): Promise<ComputerProgramResolution<Binding>> => {
    const command = request.command;
    if (request.target.kind === "resolved") {
      if (!command.executable.startsWith("/") || !request.aliases?.has(command.executable))
        return { command };
      try {
        const stat = await request.namespace.inspect(
          command.executable,
          executableArtifact(request.target.binding),
        );
        request.signal.throwIfAborted();
        if (stat.type === "file" && (stat.lower || stat.matchesArtifact)) return { command };
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
        const inspected = await request.namespace.inspect(path);
        request.signal.throwIfAborted();
        lower = inspected.lower;
        if (inspected.type !== "file") continue;
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

function executableArtifact(binding: {
  readonly implementation: object;
}): KernelExecutableArtifact | undefined {
  const implementation = binding.implementation;
  if (!("executableArtifact" in implementation)) return undefined;
  const artifact = implementation.executableArtifact;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    !("bytes" in artifact) ||
    typeof artifact.bytes !== "number" ||
    !("sha256" in artifact) ||
    typeof artifact.sha256 !== "string"
  )
    return undefined;
  return { bytes: artifact.bytes, sha256: artifact.sha256 };
}

function absolutePath(path: string, cwd: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
