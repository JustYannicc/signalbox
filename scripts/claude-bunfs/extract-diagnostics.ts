// @effect-diagnostics nodeBuiltinImport:off nodeBuiltinProcess:off - standalone extraction diagnostics run in Node.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { regionNames, type BunModule } from "./bun-graph.ts";

type GraphForPlan = {
  length: number;
  modules: readonly BunModule[];
  linkedBytecodePayload: { offset: number; length: number } | undefined;
};

function recordRegionBytes(graph: GraphForPlan) {
  const byKind = Object.fromEntries(
    regionNames.slice(1).map((kind) => [kind, { bytes: 0, files: 0 }]),
  ) as Record<string, { bytes: number; files: number }>;
  const regions: { module: string; kind: string; offset: number; bytes: number }[] = [];
  for (const module of graph.modules) {
    for (const kind of regionNames.slice(1)) {
      const region = module.regions[kind];
      if (!region || (kind !== "contents" && region.length === 0)) continue;
      const stats = byKind[kind]!;
      stats.bytes += region.length;
      stats.files++;
      regions.push({ module: module.name, kind, offset: region.offset, bytes: region.length });
    }
  }
  regions.sort(
    (left, right) => right.bytes - left.bytes || left.module.localeCompare(right.module),
  );
  const largest = regions.slice(0, 12);
  return { byKind, largest };
}

export function extractionPlan(graph: GraphForPlan, materialize: boolean) {
  const { byKind, largest } = recordRegionBytes(graph);
  const moduleRegionBytes = Object.values(byKind).reduce((sum, value) => sum + value.bytes, 0);
  const bytecodeBytes = byKind.bytecode?.bytes ?? 0;
  const separateRegionBytes = moduleRegionBytes - bytecodeBytes;
  const materializedRegionBytes = !materialize
    ? 0
    : separateRegionBytes + (graph.linkedBytecodePayload?.length ?? bytecodeBytes);
  return {
    mode: materialize ? "materialized" : "manifest-only",
    moduleCount: graph.modules.length,
    graphBytes: graph.length,
    moduleRegionBytes,
    payloadBytes: materialize ? graph.length + materializedRegionBytes : 0,
    regionBytesByKind: Object.fromEntries(
      Object.entries(byKind).map(([kind, stats]) => [
        kind,
        {
          bytes: stats.bytes,
          files: stats.files,
          materializedBytes:
            !materialize || (kind === "bytecode" && graph.linkedBytecodePayload)
              ? kind === "bytecode" && materialize
                ? (graph.linkedBytecodePayload?.length ?? 0)
                : 0
              : stats.bytes,
          materializedFiles:
            !materialize || (kind === "bytecode" && graph.linkedBytecodePayload)
              ? kind === "bytecode" && materialize && graph.linkedBytecodePayload
                ? 1
                : 0
              : stats.files,
        },
      ]),
    ),
    ...(graph.linkedBytecodePayload
      ? {
          linkedBytecodePayloadBytes: graph.linkedBytecodePayload.length,
          linkedBytecodeLogicalBytes: bytecodeBytes,
        }
      : {}),
    largestRegions: largest,
  };
}

async function existingPath(path: string) {
  let current = NodePath.resolve(path);
  while (true) {
    try {
      await NodeFSP.stat(current);
      return current;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
      const parent = NodePath.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function diskUsage(flag: "-hP" | "-iP", path: string) {
  try {
    const result = NodeChildProcess.spawnSync("df", [flag, path], {
      encoding: "utf8",
      timeout: 5000,
    });
    return {
      command: `df ${flag}`,
      status: result.status,
      stdout: result.stdout.trim(),
      ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
      ...(result.error ? { error: result.error.message } : {}),
    };
  } catch (error) {
    return {
      command: `df ${flag}`,
      status: null,
      stdout: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function logExtractionFilesystemPlan(input: {
  binary: string;
  output: string;
  stage: string;
  moduleCount: number;
  hasLinkedBytecode: boolean;
  emit(event: Record<string, unknown>): void;
}) {
  const output = NodePath.resolve(input.output);
  const stage = NodePath.resolve(input.stage);
  const outputParent = NodePath.dirname(output);
  const paths: {
    role: string;
    path: string;
    auxiliary?: boolean;
    writeTarget?: boolean;
    owner?: string;
  }[] = [
    { role: "source-binary-read", path: input.binary, writeTarget: false },
    { role: "binary-download-partial", path: `${input.binary}.partial-*`, writeTarget: true },
    { role: "final-output-rename", path: output },
    { role: "partial-stage-root", path: stage },
    { role: "serialized-graph-file", path: NodePath.join(stage, ".bun-data/graph.bin") },
    ...(input.hasLinkedBytecode
      ? [
          {
            role: "linked-bytecode-file",
            path: NodePath.join(stage, ".bun-data/linked-bytecode.bin"),
          },
        ]
      : []),
    { role: "module-artifact-root", path: stage },
    { role: "manifest-file", path: NodePath.join(stage, "manifest.json") },
    {
      role: "release-provenance-file",
      path: NodePath.join(stage, ".bun-data/release.json"),
      owner: "extractRelease",
    },
    { role: "partial-stage-parent", path: outputParent },
    ...[
      ["runner-temp", process.env.RUNNER_TEMP],
      ["tmpdir-env", process.env.TMPDIR],
      ["temp-env", process.env.TEMP],
      ["tmp-env", process.env.TMP],
      ["os-tmpdir", NodeOS.tmpdir()],
    ]
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
      .map(([role, path]) => ({ role, path, auxiliary: true, writeTarget: false })),
  ];

  for (const item of paths) {
    let inspectedPath: string;
    try {
      inspectedPath = await existingPath(item.path);
    } catch (error) {
      inspectedPath = "";
      input.emit({
        event: "bun-extraction-filesystem",
        role: item.role,
        targetPath: item.path,
        status: "path-unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    input.emit({
      event: "bun-extraction-filesystem",
      role: item.role,
      targetPath: item.path,
      inspectedPath,
      writeTarget: item.writeTarget ?? !item.auxiliary,
      ...(item.auxiliary ? { usedByExtractor: false } : { usedByExtractor: true }),
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.role === "module-artifact-root" ? { moduleCount: input.moduleCount } : {}),
      df: [diskUsage("-hP", inspectedPath), diskUsage("-iP", inspectedPath)],
    });
  }
  input.emit({
    event: "bun-extraction-filesystem-scope",
    stageRoot: stage,
    stageParent: outputParent,
    allMaterializedFilesBelowStageRoot: true,
    logicalModuleFiles: input.moduleCount,
  });
}
