// @effect-diagnostics nodeBuiltinImport:off - packages pinned local proof inputs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import { bashMain, busyboxMain, ripgrepMain } from "./workerEntrypoints.ts";
import {
  packageGraph,
  programInventory,
  recordFile,
  digest,
  byPath,
  type ChildProgramSourceRecord,
} from "./packageGraph.ts";

const ARTIFACTS = {
  bash: { file: "bash.wasm", ...KERNEL_BASH_ARTIFACT },
  busybox: { file: "busybox.wasm", ...KERNEL_BUSYBOX_ARTIFACT },
  ripgrep: { file: "rg.wasm", ...KERNEL_RIPGREP_ARTIFACT },
} as const;

export async function prepareBasePrograms(options: {
  readonly programDir: string;
  readonly cloudRoot?: string;
}) {
  if (options == null) throw new Error("Pass the pinned program directory");
  const programDir = NodePath.resolve(options.programDir);
  const cloudRoot = await NodeFSP.realpath(
    options.cloudRoot ?? NodePath.resolve(import.meta.dirname, "../.."),
  );
  const sources = new Map<string, ChildProgramSourceRecord>();
  const artifacts = new Map<string, ChildProgramSourceRecord>();
  const [bashArtifact, busyboxArtifact, ripgrepArtifact] = await Promise.all([
    readArtifact(programDir, ARTIFACTS.bash, artifacts),
    readArtifact(programDir, ARTIFACTS.busybox, artifacts),
    readArtifact(programDir, ARTIFACTS.ripgrep, artifacts),
  ]);
  const [bashGraph, busyboxGraph, ripgrepGraph] = await Promise.all([
    packageGraph(cloudRoot, "src/computer/ChildBash.ts", "ChildBash", bashMain, sources),
    packageGraph(cloudRoot, "src/computer/ChildBusybox.ts", "ChildBusybox", busyboxMain, sources),
    packageGraph(cloudRoot, "src/computer/ChildWasi.ts", "ChildRipgrep", ripgrepMain, sources),
  ]);
  return {
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
  };
}

/** Historical hook and routing proofs require only these three pinned executables. */
export async function prepareBasicChildPrograms(
  options: Parameters<typeof prepareBasePrograms>[0],
) {
  const base = await prepareBasePrograms(options);
  for (const path of [
    "infra/childPrograms/basic.ts",
    "infra/childPrograms/packageGraph.ts",
    "infra/childPrograms/runtime.ts",
    "infra/childPrograms/workerEntrypoints.ts",
    "src/kernel/KernelBashProgram.ts",
    "src/kernel/KernelBusyboxProgram.ts",
    "src/kernel/KernelRipgrepProgram.ts",
  ])
    await recordFile(base.cloudRoot, path, base.sources);
  const executableFiles = Object.freeze([
    { path: "/bin/bash" as const, ...base.bashArtifact, mode: 0o755 as const },
    { path: "/bin/cat" as const, ...base.busyboxArtifact, mode: 0o755 as const },
    { path: "/bin/rg" as const, ...base.ripgrepArtifact, mode: 0o755 as const },
  ]);
  return Object.freeze({
    bash: base.bashGraph.code,
    busyboxCat: base.busyboxGraph.code,
    ripgrep: base.ripgrepGraph.code,
    executableFiles,
    executableCatalog: Object.freeze(
      Object.fromEntries(
        executableFiles.map((file) => [
          file.path,
          {
            bytes: file.bytes.byteLength,
            sha256: file.sha256,
          },
        ]),
      ),
    ),
    sourceInventory: Object.freeze({
      format: "signalbox-hook-child-programs-v1" as const,
      sources: Object.freeze([...base.sources.values()].sort(byPath)),
      artifacts: Object.freeze([...base.artifacts.values()].sort(byPath)),
      programs: Object.freeze({
        bash: programInventory(base.bashGraph),
        busyboxCat: programInventory(base.busyboxGraph),
        ripgrep: programInventory(base.ripgrepGraph),
      }),
    }),
  });
}

async function readArtifact(
  programDir: string,
  artifact: (typeof ARTIFACTS)[keyof typeof ARTIFACTS],
  inventory: Map<string, ChildProgramSourceRecord>,
) {
  const bytes = await NodeFSP.readFile(NodePath.join(programDir, artifact.file));
  const sha256 = digest(bytes);
  if (bytes.byteLength !== artifact.bytes || sha256 !== artifact.sha256)
    throw new Error(`Pinned child program does not match ${artifact.file}`);
  inventory.set(artifact.file, { path: artifact.file, bytes: bytes.byteLength, sha256 });
  return { bytes, sha256 };
}
