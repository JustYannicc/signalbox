import {
  CHILD_BUSYBOX_APPLETS,
  CHILD_PRODUCT_BUSYBOX_APPLETS,
  CHILD_PROGRAM_PATHS,
  CHILD_UGREP_EXECUTABLES,
  type ChildCoreutilsCommand,
} from "../../src/computer/ChildProgramSet.ts";
import { childProgramPaths } from "../../src/computer/ChildProgramPaths.ts";
import {
  prepareMeasuredPrograms,
  readPinnedProgram,
  verifyProgramProvenance,
  type MeasuredChildProgramSources,
} from "./measured.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../src/kernel/KernelGnuPrograms.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../src/kernel/KernelUgrepProgram.ts";
import { PRODUCT_COMPUTER_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_JQ_ARTIFACT } from "../../src/kernel/KernelJqProgram.ts";
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
  readonly productBusyboxApplets: ChildProgramSourceCode;
  readonly coreutils: Readonly<Record<ChildCoreutilsCommand, ChildProgramSourceCode>>;
  readonly git: ChildProgramSourceCode;
  readonly sed: ChildProgramSourceCode;
  readonly jq: ChildProgramSourceCode;
  readonly ugrep: ChildProgramSourceCode;
}

type SeededProgramPath =
  | (typeof CHILD_PROGRAM_PATHS)[keyof typeof CHILD_PROGRAM_PATHS]
  | (typeof CHILD_UGREP_EXECUTABLES)[number];
export type ChildProgramExecutablePath = ReturnType<typeof childProgramPaths<SeededProgramPath>>[
  | 1
  | 2];
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
  readonly productBusyboxApplets: ChildProgramSourceCode;
  readonly coreutils: Readonly<Record<ChildCoreutilsCommand, ChildProgramSourceCode>>;
  readonly git: ChildProgramSourceCode;
  readonly sed: ChildProgramSourceCode;
  readonly jq: ChildProgramSourceCode;
  readonly ugrep: ChildProgramSourceCode;
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
  const sedArtifact = await readPinnedProgram(
    programDir,
    "sed.wasm",
    KERNEL_GNU_SED_ARTIFACT,
    artifacts,
  );
  const productBusyboxArtifact = await readPinnedProgram(
    programDir,
    "product-busybox.wasm",
    PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
    artifacts,
  );
  const ugrepArtifact = await readPinnedProgram(
    programDir,
    "ugrep.wasm",
    KERNEL_UGREP_ARTIFACT,
    artifacts,
  );
  const jqArtifact = await readPinnedProgram(
    programDir,
    KERNEL_JQ_ARTIFACT.preparedFile,
    KERNEL_JQ_ARTIFACT,
    artifacts,
  );
  await verifyProgramProvenance(programDir, "product-busybox.provenance.json", {
    bytes: PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.bytes,
    sha256: PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.sha256,
    revision: PRODUCT_COMPUTER_BUSYBOX_ARTIFACT.revision,
  });
  await verifyProgramProvenance(programDir, "jq.provenance.json", {
    bytes: KERNEL_JQ_ARTIFACT.bytes,
    sha256: KERNEL_JQ_ARTIFACT.sha256,
    revision: KERNEL_JQ_ARTIFACT.version,
  });
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
    "infra/kernelPrograms/coreutils/build-busybox-buffered.sh",
    "infra/kernelPrograms/coreutils/prepare-product-busybox.mjs",
    "infra/kernelPrograms/coreutils/patches/0004-busybox-1m-copy-buffer.patch",
    "infra/kernelPrograms/coreutils/patches/0006-busybox-target-ar.patch",
    "infra/kernelPrograms/coreutils/patches/0007-busybox-id-applet.patch",
    "infra/kernelPrograms/coreutils/patches/0008-nimbus-getgrouplist.patch",
    "infra/kernelPrograms/jq/provenance.json",
    "infra/kernelPrograms/jq/prepare.mjs",
    "infra/kernelPrograms/ugrep/provenance.json",
    "infra/kernelPrograms/ugrep/build.sh",
    "infra/kernelPrograms/ugrep/patches/0001-wasi-disable-vkey-tui.patch",
    "infra/kernelPrograms/ugrep/compat/wasi-process-unavailable.h",
    "infra/kernelPrograms/ugrep/compat/wasi-process-unavailable.c",
    "infra/kernelPrograms/git/provenance.json",
    "src/computer/ChildProgramSet.ts",
    "src/computer/ChildProgramCatalog.ts",
    "src/computer/catalog/BusyboxPrograms.ts",
    "src/computer/catalog/ChildProgramFactory.ts",
    "src/computer/catalog/JqProgram.ts",
    "src/computer/catalog/SedPrograms.ts",
    "src/computer/catalog/UgrepPrograms.ts",
    "src/computer/UgrepCommand.ts",
    "src/computer/CommandGateway.ts",
    "src/computer/CompiledChildWorkerLoader.ts",
    "src/kernel/KernelBashProgram.ts",
    "src/kernel/KernelBusyboxProgram.ts",
    "src/kernel/KernelBusyboxPrograms.ts",
    "src/kernel/KernelJqProgram.ts",
    "src/kernel/KernelGnuPrograms.ts",
    "src/kernel/KernelUgrepProgram.ts",
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
    productBusyboxApplets: busyboxGraph.code,
    ripgrep: ripgrepGraph.code,
    coreutils: measured.coreutils,
    git: measured.git,
    sed: busyboxGraph.code,
    jq: measured.graphs.coreutils.code,
    ugrep: busyboxGraph.code,
  });
  const inventory: ChildProgramSourceInventory = Object.freeze({
    format: "signalbox-child-programs-v1",
    sources: Object.freeze([...sources.values()].sort(byPath)),
    artifacts: Object.freeze([...artifacts.values()].sort(byPath)),
    programs: Object.freeze({
      bash: programInventory(bashGraph),
      busyboxCat: programInventory(busyboxGraph),
      busyboxApplets: programInventory(busyboxGraph),
      productBusyboxApplets: programInventory(busyboxGraph),
      ripgrep: programInventory(ripgrepGraph),
      coreutils: programInventory(measured.graphs.coreutils),
      git: programInventory(measured.graphs.git),
      sed: programInventory(busyboxGraph),
      jq: programInventory(measured.graphs.coreutils),
      ugrep: programInventory(busyboxGraph),
    }),
  });
  const canonicalFiles = [
    executableFile("/bin/bash", bashArtifact),
    executableFile("/bin/cat", busyboxArtifact),
    executableFile("/bin/rg", ripgrepArtifact),
    executableFile("/bin/sh", bashArtifact),
    ...CHILD_BUSYBOX_APPLETS.filter((applet) => applet !== "cat").map((applet) =>
      executableFile(CHILD_PROGRAM_PATHS[applet], busyboxArtifact),
    ),
    ...CHILD_PRODUCT_BUSYBOX_APPLETS.map((applet) =>
      executableFile(CHILD_PROGRAM_PATHS[applet], productBusyboxArtifact),
    ),
    ...measured.files,
    executableFile(CHILD_PROGRAM_PATHS.sed, sedArtifact),
    executableFile(CHILD_PROGRAM_PATHS.jq, jqArtifact),
    ...CHILD_UGREP_EXECUTABLES.map((path) =>
      executableFile(childProgramPaths(path)[1], ugrepArtifact),
    ),
  ];
  const commandExecutableFiles = Object.freeze(
    canonicalFiles.flatMap((file) => {
      const [, bin, usrBin] = childProgramPaths(file.path);
      return [
        { ...file, path: bin },
        { ...file, path: usrBin },
      ];
    }),
  );
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
  const expectedPaths = new Set(
    [...Object.values(CHILD_PROGRAM_PATHS), ...CHILD_UGREP_EXECUTABLES].flatMap((path) =>
      childProgramPaths(path).slice(1),
    ),
  );
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
