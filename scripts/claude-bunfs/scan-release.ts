// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - build-time release inventory and CLI diagnostics.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { readExtraction } from "./extracted-input.ts";
import {
  scanClaudeReleaseInventory,
  diffReleaseInventories,
  type ClaudeReleaseInventory,
  type ReleaseInventoryDiff,
} from "./release-inventory.ts";
import type { BuiltinCapabilityManifest } from "./builtin-gap.ts";
import {
  createReleaseReport,
  recordReleaseCheck,
  type CheckResult,
  type ReleaseReport,
} from "./release-report.ts";

export function reportReleaseInventory(inventory: ClaudeReleaseInventory): ReleaseReport {
  const release = {
    provider: "claude-code" as const,
    ...inventory.release,
    binarySha256: inventory.binary.sha256,
  };
  let report: ReleaseReport = {
    ...createReleaseReport(release),
    inventory,
    builtinGaps: [...inventory.builtinGaps, ...inventory.bunCapabilityGaps],
    codegenFindings: inventory.codegenFindings,
  };
  const checked = (
    failures: ReadonlyArray<
      { module: string; line: number; column: number; guarded?: boolean } & (
        | { reason: string; name: string }
        | { kind: string; specifier: string }
      )
    >,
  ): CheckResult => ({
    status: failures.some(
      (item) =>
        !(
          item.guarded &&
          "reason" in item &&
          ["unguarded-unsupported-use", "missing-named-export", "missing-commonjs-member"].includes(
            item.reason,
          )
        ),
    )
      ? "fail"
      : failures.length
        ? "pending"
        : "pass",
    diagnostics: failures.map((item) => ({
      code: "reason" in item ? item.reason : item.kind,
      message: `${item.module}:${item.line}:${item.column}: ${"name" in item ? item.name : item.specifier}`,
    })),
  });
  report = recordReleaseCheck(
    report,
    release,
    "inventory",
    checked([...inventory.unresolvedReferences, ...inventory.unresolvedBareReferences]),
  );
  report = recordReleaseCheck(report, release, "builtinGaps", checked(inventory.builtinGaps));
  report = recordReleaseCheck(
    report,
    release,
    "bunCapabilities",
    checked(inventory.bunCapabilityGaps),
  );
  report = recordReleaseCheck(report, release, "codegen", {
    status: inventory.codegenFindings.length ? "pending" : "pass",
    diagnostics: inventory.codegenFindings.map((item) => ({
      code: "CODEGEN_DISPOSITION_REQUIRED",
      message: `${item.module}:${item.line}:${item.column}: ${item.kind} ${item.operation}`,
    })),
  });
  return report;
}

export interface ScanExtractedReleaseOptions {
  readonly extracted: string;
  readonly version: string;
  readonly platform: string;
  readonly bunVersion: string | null;
  readonly capabilities: BuiltinCapabilityManifest;
}

export async function scanExtractedRelease(options: ScanExtractedReleaseOptions) {
  const extraction = await readExtraction(options.extracted);
  const modules = [];
  for (const module of extraction.manifest.modules) {
    // Verify non-JS artifacts too; an inventory must not hide damaged native/asset payloads.
    const contents = await extraction.readContents(module);
    modules.push({
      index: module.index,
      name: module.name,
      key: module.key ?? module.name.replace(/^\/+/, ""),
      loader: module.loader,
      format: module.format,
      bytes: contents.byteLength,
      ...(module.loader === 1 ? { source: await extraction.readSource(module) } : {}),
    });
  }
  const inventory = scanClaudeReleaseInventory({
    release: {
      version: options.version,
      platform: options.platform,
      bunVersion: options.bunVersion,
    },
    binary: extraction.manifest.binary,
    graph: extraction.manifest.graph,
    modules,
    capabilities: options.capabilities,
  });
  // Payload hashes do not independently prove the original binary; extraction evidence remains pending.
  return { inventory, report: reportReleaseInventory(inventory) };
}

export async function writeReleaseScan(
  output: string,
  scan: { inventory: ClaudeReleaseInventory; report: ReleaseReport },
  diff?: ReleaseInventoryDiff,
) {
  const target = NodePath.resolve(output);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const stage = await NodeFSP.mkdtemp(`${target}.partial-`);
  try {
    for (const [name, value] of Object.entries({
      "inventory.json": scan.inventory,
      "release-report.json": scan.report,
      ...(diff ? { "diff.json": diff } : {}),
    }))
      await NodeFSP.writeFile(NodePath.join(stage, name), `${JSON.stringify(value, null, 2)}\n`);
    try {
      await NodeFSP.lstat(target);
      throw new Error("RELEASE_SCAN_OUTPUT_EXISTS");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await NodeFSP.rename(stage, target);
  } catch (error) {
    await NodeFSP.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function compareReleaseScan(
  baseline: ClaudeReleaseInventory,
  candidate: ClaudeReleaseInventory,
): ReleaseInventoryDiff {
  if (baseline.release.platform !== candidate.release.platform)
    throw new Error("RELEASE_BASELINE_PLATFORM_MISMATCH");
  return diffReleaseInventories(baseline, candidate);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [extracted, capabilitiesFile, output, version, platform, bunVersion, baselineFile] =
    process.argv.slice(2);
  if (!extracted || !capabilitiesFile || !output || !version || !platform || !bunVersion)
    throw new Error(
      "Usage: scan-release.ts <extracted> <capabilities.json> <new-output> <version> <platform> <bun-version|unknown> [baseline-inventory.json]",
    );
  const scan = await scanExtractedRelease({
    extracted,
    version,
    platform,
    bunVersion: bunVersion === "unknown" ? null : bunVersion,
    capabilities: JSON.parse(await NodeFSP.readFile(capabilitiesFile, "utf8")),
  });
  const diff = baselineFile
    ? compareReleaseScan(JSON.parse(await NodeFSP.readFile(baselineFile, "utf8")), scan.inventory)
    : undefined;
  await writeReleaseScan(output, scan, diff);
  const failures = Object.entries(scan.report.checks).filter(
    ([, check]) => check.status === "fail",
  );
  if (failures.length || diff?.newUnguardedNames.length) {
    for (const [name, check] of failures)
      for (const diagnostic of check.diagnostics)
        console.error(`${name}: ${diagnostic.code}: ${diagnostic.message}`);
    for (const gap of diff?.newUnguardedNames ?? [])
      console.error(
        `new unguarded API: ${gap.module}:${gap.line}:${gap.column}: ${gap.name} (${gap.reason})`,
      );
    process.exitCode = 1;
  }
}
