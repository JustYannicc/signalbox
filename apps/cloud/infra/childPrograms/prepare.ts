// @effect-diagnostics nodeBuiltinImport:off - this file packages local proof artifacts.
import {
  CHILD_BUSYBOX_APPLETS,
  CHILD_PROGRAM_PATHS,
  type ChildCoreutilsCommand,
} from "../../src/computer/ChildProgramSet.ts";
import { prepareMeasuredPrograms, type MeasuredChildProgramSources } from "./measured.ts";
import { prepareBasePrograms } from "./basic.ts";
import {
  readPinnedGitTemplates,
  type ChildProgramDataFile,
  type ChildProgramDataCatalog,
} from "./gitTemplates.ts";

import {
  programInventory,
  recordFile,
  byPath,
  type ChildProgramSourceRecord,
  type ChildProgramSourceCode,
} from "./packageGraph.ts";
export type { ChildProgramSourceRecord, ChildProgramSourceCode } from "./packageGraph.ts";

export interface ChildProgramSourceInventory {
  readonly format: "signalbox-child-programs-v1";
  readonly sources: readonly ChildProgramSourceRecord[];
  readonly artifacts: readonly ChildProgramSourceRecord[];
  readonly programs: Readonly<
    Record<
      string,
      {
        readonly entrypoint: string;
        readonly mainModule: string;
        readonly modules: readonly string[];
      }
    >
  >;
}

export interface ChildProgramSources extends MeasuredChildProgramSources {
  readonly bash: ChildProgramSourceCode;
  readonly busyboxCat: ChildProgramSourceCode;
  readonly ripgrep: ChildProgramSourceCode;
}

export interface FullChildProgramSources extends ChildProgramSources {
  readonly busyboxApplets: ChildProgramSourceCode;
  readonly coreutils: Readonly<Record<ChildCoreutilsCommand, ChildProgramSourceCode>>;
  readonly git: ChildProgramSourceCode;
}

export type ChildProgramExecutablePath =
  (typeof CHILD_PROGRAM_PATHS)[keyof typeof CHILD_PROGRAM_PATHS];
export type LegacyChildProgramExecutablePath = "/bin/bash" | "/bin/cat" | "/bin/rg";

export interface ChildProgramExecutableFile {
  readonly path: ChildProgramExecutablePath;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mode: 0o755;
}

export interface LegacyChildProgramExecutableFile extends Omit<ChildProgramExecutableFile, "path"> {
  readonly path: LegacyChildProgramExecutablePath;
}

export type ChildProgramExecutableCatalog = Readonly<
  Record<
    ChildProgramExecutablePath,
    { readonly bytes: number; readonly sha256: string; readonly mode: 0o755 }
  >
>;
export type LegacyChildProgramExecutableCatalog = Readonly<
  Record<LegacyChildProgramExecutablePath, { readonly bytes: number; readonly sha256: string }>
>;

export interface PreparedChildPrograms extends ChildProgramSources {
  readonly busyboxApplets: ChildProgramSourceCode;
  readonly coreutils: Readonly<Record<ChildCoreutilsCommand, ChildProgramSourceCode>>;
  readonly git: ChildProgramSourceCode;
  readonly programs: FullChildProgramSources;
  readonly executableFiles: readonly LegacyChildProgramExecutableFile[];
  readonly executableCatalog: LegacyChildProgramExecutableCatalog;
  readonly commandExecutableFiles: readonly ChildProgramExecutableFile[];
  readonly commandExecutableCatalog: ChildProgramExecutableCatalog;
  readonly dataFiles: readonly ChildProgramDataFile[];
  readonly dataCatalog: ChildProgramDataCatalog;
  readonly sourceInventory: ChildProgramSourceInventory;
}

export interface PrepareChildProgramsOptions {
  readonly programDir: string;
  readonly cloudRoot?: string;
}

/** Builds static Dynamic Worker modules and returns verified WASM bytes for the seed bundle. */
export async function prepareChildPrograms(
  options: PrepareChildProgramsOptions,
): Promise<PreparedChildPrograms> {
  const {
    programDir,
    cloudRoot,
    sources,
    artifacts,
    bashArtifact,
    busyboxArtifact,
    ripgrepArtifact,
    bashGraph,
    busyboxGraph,
    ripgrepGraph,
  } = await prepareBasePrograms(options);
  const measured = await prepareMeasuredPrograms({ cloudRoot, programDir, sources, artifacts });
  const gitTemplates = await readPinnedGitTemplates(programDir);
  for (const file of gitTemplates.dataFiles) {
    artifacts.set(file.path, {
      path: file.path,
      bytes: file.bytes.byteLength,
      sha256: file.sha256,
    });
  }

  for (const relativePath of [
    "infra/childPrograms/prepare.ts",
    "infra/childPrograms/basic.ts",
    "infra/childPrograms/runtime.ts",
    "infra/childPrograms/packageGraph.ts",
    "infra/childPrograms/measured.ts",
    "infra/childPrograms/gitTemplates.ts",
    "infra/childPrograms/gitTemplates.manifest.json",
    "infra/childPrograms/gitTemplateManifest.ts",
    "infra/kernelPrograms/coreutils/provenance.json",
    "infra/kernelPrograms/git/provenance.json",
    "src/computer/ChildProgramSet.ts",
    "src/computer/ChildProgramCatalog.ts",
    "src/computer/CommandGateway.ts",
    "src/computer/CompiledChildWorkerLoader.ts",
    "src/kernel/KernelBashProgram.ts",
    "src/kernel/KernelBusyboxProgram.ts",
    "src/kernel/KernelBusyboxPrograms.ts",
    "src/kernel/KernelCoreutilsPrograms.ts",
    "src/kernel/KernelGitProgram.ts",
    "src/kernel/KernelRipgrepProgram.ts",
    "infra/childPrograms/workerEntrypoints.ts",
  ]) {
    await recordFile(cloudRoot, relativePath, sources);
  }

  const programs: FullChildProgramSources = Object.freeze({
    bash: bashGraph.code,
    busyboxCat: busyboxGraph.code,
    busyboxApplets: busyboxGraph.code,
    ripgrep: ripgrepGraph.code,
    coreutils: measured.coreutils,
    git: measured.git,
  });
  const inventory: ChildProgramSourceInventory = Object.freeze({
    format: "signalbox-child-programs-v1",
    sources: Object.freeze([...sources.values()].sort(byPath)),
    artifacts: Object.freeze([...artifacts.values()].sort(byPath)),
    programs: Object.freeze({
      bash: programInventory(bashGraph),
      busyboxCat: programInventory(busyboxGraph),
      busyboxApplets: programInventory(busyboxGraph),
      ripgrep: programInventory(ripgrepGraph),
      coreutils: programInventory(measured.graphs.coreutils),
      git: programInventory(measured.graphs.git),
    }),
  });
  const commandExecutableFiles = Object.freeze([
    executableFile("/bin/bash", bashArtifact),
    executableFile("/bin/cat", busyboxArtifact),
    executableFile("/bin/rg", ripgrepArtifact),
    executableFile("/bin/sh", bashArtifact),
    ...CHILD_BUSYBOX_APPLETS.filter((applet) => applet !== "cat").map((applet) =>
      executableFile(CHILD_PROGRAM_PATHS[applet], busyboxArtifact),
    ),
    ...measured.files,
  ]);
  const commandExecutableCatalog = createChildProgramExecutableCatalog(commandExecutableFiles);
  const executableFiles = Object.freeze(
    commandExecutableFiles.filter(
      (file): file is LegacyChildProgramExecutableFile =>
        file.path === "/bin/bash" || file.path === "/bin/cat" || file.path === "/bin/rg",
    ),
  );
  const executableCatalog = Object.freeze({
    "/bin/bash": commandExecutableCatalog["/bin/bash"],
    "/bin/cat": commandExecutableCatalog["/bin/cat"],
    "/bin/rg": commandExecutableCatalog["/bin/rg"],
  });
  return Object.freeze({
    ...programs,
    programs,
    executableFiles,
    executableCatalog,
    commandExecutableFiles,
    commandExecutableCatalog,
    ...gitTemplates,
    sourceInventory: inventory,
  });
}

export function createChildProgramExecutableCatalog(
  files: readonly ChildProgramExecutableFile[],
): ChildProgramExecutableCatalog {
  const expectedPaths = new Set(Object.values(CHILD_PROGRAM_PATHS));
  if (
    files.length !== expectedPaths.size ||
    files.some((file) => !expectedPaths.delete(file.path)) ||
    expectedPaths.size !== 0
  ) {
    throw new Error("Prepared child executables do not cover the full command catalog");
  }
  return Object.freeze(
    Object.fromEntries(
      files.map((file) => [
        file.path,
        Object.freeze({ bytes: file.bytes.byteLength, sha256: file.sha256, mode: file.mode }),
      ]),
    ),
  ) as ChildProgramExecutableCatalog;
}

function executableFile(
  path: ChildProgramExecutablePath,
  artifact: { readonly bytes: Uint8Array; readonly sha256: string },
): ChildProgramExecutableFile {
  return Object.freeze({ path, ...artifact, mode: 0o755 });
}
