// @effect-diagnostics nodeBuiltinImport:off - packages pinned local command artifacts.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CHILD_COREUTILS_COMMANDS,
  type ChildCoreutilsCommand,
} from "../../src/computer/ChildProgramSet.ts";
import { KERNEL_GIT_ARTIFACT } from "../../src/kernel/KernelGitProgram.ts";
import {
  digest,
  packageGraph,
  type ChildProgramSourceCode,
  type ChildProgramSourceRecord,
} from "./packageGraph.ts";
import { measuredProgramMain } from "./workerEntrypoints.ts";

export interface MeasuredChildProgramSources {
  readonly busyboxApplets?: ChildProgramSourceCode;
  readonly coreutils?: Partial<Readonly<Record<ChildCoreutilsCommand, ChildProgramSourceCode>>>;
  readonly git?: ChildProgramSourceCode;
}

export interface ProgramPin {
  readonly bytes: number;
  readonly sha256: string;
}

export async function prepareMeasuredPrograms(options: {
  readonly cloudRoot: string;
  readonly programDir: string;
  readonly sources: Map<string, ChildProgramSourceRecord>;
  readonly artifacts: Map<string, ChildProgramSourceRecord>;
}) {
  const provenance = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(options.cloudRoot, "infra/kernelPrograms/coreutils/provenance.json"),
      "utf8",
    ),
  ) as {
    readonly commands: Readonly<Record<ChildCoreutilsCommand, ProgramPin>>;
  };
  const [coreutilsGraph, gitGraph] = await Promise.all([
    packageGraph(
      options.cloudRoot,
      "src/computer/ChildCoreutils.ts",
      "ChildCoreutils",
      measuredProgramMain("Coreutils"),
      options.sources,
    ),
    packageGraph(
      options.cloudRoot,
      "src/computer/ChildGit.ts",
      "ChildGit",
      measuredProgramMain("Git"),
      options.sources,
    ),
  ]);
  const coreutils = {} as Record<ChildCoreutilsCommand, ChildProgramSourceCode>;
  const files: {
    readonly path: `/bin/${ChildCoreutilsCommand}` | "/usr/bin/git";
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly mode: 0o755;
  }[] = [];
  for (const command of CHILD_COREUTILS_COMMANDS) {
    const artifact = await readPinnedProgram(
      options.programDir,
      `coreutils/${command}.wasm`,
      provenance.commands[command],
      options.artifacts,
    );
    files.push({ path: `/bin/${command}`, ...artifact, mode: 0o755 });
    coreutils[command] = coreutilsGraph.code;
  }
  const git = await readPinnedProgram(
    options.programDir,
    "git.wasm",
    KERNEL_GIT_ARTIFACT,
    options.artifacts,
  );
  files.push({ path: "/usr/bin/git", ...git, mode: 0o755 });
  return {
    coreutils: Object.freeze(coreutils),
    git: gitGraph.code,
    files,
    graphs: { coreutils: coreutilsGraph, git: gitGraph },
  };
}

export async function readPinnedProgram(
  programDir: string,
  file: string,
  pin: ProgramPin,
  inventory: Map<string, ChildProgramSourceRecord>,
) {
  const bytes = await NodeFSP.readFile(NodePath.join(programDir, file));
  const sha256 = digest(bytes);
  if (bytes.byteLength !== pin.bytes || sha256 !== pin.sha256)
    throw new Error(`Pinned child program does not match ${file}`);
  inventory.set(file, { path: file, bytes: bytes.byteLength, sha256 });
  return { bytes: new Uint8Array(bytes), sha256 };
}
