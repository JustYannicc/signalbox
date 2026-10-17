// @effect-diagnostics nodeBuiltinImport:off - compares native compiler processes in CI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import getExePath from "@effect/tsgo/lib/getExePath";
import { BenchmarkInterrupted, runTypecheck, sampleIntervalMs } from "./lib/typecheck-process.ts";
import {
  discoverWorkspaces,
  resolveBaselineCommit,
  loadBaselineScripts,
  planBaselineTypecheckScripts,
  withTemporaryTypecheckScripts,
} from "./lib/typecheck-workspaces.ts";

const root = NodePath.resolve(NodeURL.fileURLToPath(new URL("../", import.meta.url)));

function installInterruptHandlers() {
  const controller = new AbortController();
  const sigint = () => controller.abort("SIGINT");
  const sigterm = () => controller.abort("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function runStatus(run: Awaited<ReturnType<typeof runTypecheck>> | undefined) {
  if (!run) return "not run";
  return run.signal
    ? `signal ${run.signal}`
    : run.exitCode === 0
      ? "passed"
      : `exit ${run.exitCode ?? "unknown"}`;
}

function emitReport(
  report: Record<string, unknown>,
  runs: (Awaited<ReturnType<typeof runTypecheck>> | undefined)[],
  baselineRef: string,
) {
  process.stdout.write(`TYPECHECK_BENCHMARK_JSON ${JSON.stringify(report)}\n`);
  const [before, after] = runs;
  const baselineLabel = String(
    report.baselineLabel ?? "baseline scripts with Effect-equivalent tsc commands",
  );
  const notes = report.scriptCoverage as Record<string, string[]> | undefined;
  const noteLabels: Record<string, string> = {
    newWorkspaces: "New candidate workspaces use their current scripts in both runs",
    baselineWithoutTypecheck: "Baseline workspaces without a typecheck script are omitted before",
    baselineOnlyTypecheck: "Baseline-only typecheck scripts are added before",
    currentOnlyTypecheck: "Current-only typecheck scripts are omitted before",
    baselineOnlyWorkspaces: "Baseline workspaces absent from candidate sources are omitted",
  };
  const coverage = Object.entries(notes ?? {})
    .filter(([, paths]) => paths.length > 0)
    .map(([name, paths]) => `- ${noteLabels[name]}: ${paths.join(", ")}`);
  const seconds = (run: Awaited<ReturnType<typeof runTypecheck>> | undefined) =>
    run ? (run.wallMilliseconds / 1000).toFixed(2) : "—";
  const mib = (run: Awaited<ReturnType<typeof runTypecheck>> | undefined) =>
    run ? (run.peakAggregateRssBytes / 1024 / 1024).toFixed(1) : "—";
  const summary = [
    "## Full typecheck benchmark",
    "",
    `Baseline ref: \`${baselineRef.replaceAll("|", "\\|")}\`. Both runs use this candidate checkout and installed dependencies; only matching workspace \`scripts.typecheck\` values differ.`,
    `The Effect-equivalent baseline maps only baseline \`tsc\` command tokens to the resolved \`@effect/tsgo\` binary \`${String(report.effectCompilerPath ?? "unresolved").replaceAll("|", "\\|")}\`; \`tsc-rs\` and Astro commands stay as written.`,
    `Peak aggregate \`VmRSS\` is sampled from the captured Vite CLI PID and transitive descendants every ${sampleIntervalMs} ms.`,
    "",
    "| Run | Script set | Status | Wall time (s) | Peak aggregate RSS (MiB) |",
    "| --- | --- | --- | ---: | ---: |",
    `| Before | ${baselineLabel} | ${runStatus(before)} | ${seconds(before)} | ${mib(before)} |`,
    `| After | candidate scripts | ${runStatus(after)} | ${seconds(after)} | ${mib(after)} |`,
    ...(coverage.length ? ["", "Coverage notes:", ...coverage] : []),
    "",
  ].join("\n");
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

async function main(args: string[]) {
  if (args.length !== 1)
    throw new Error("Usage: node scripts/typecheck-benchmark.ts <baseline-git-ref>");
  const baselineRef = args[0]!;
  const interrupts = installInterruptHandlers();
  const runs: (Awaited<ReturnType<typeof runTypecheck>> | undefined)[] = [];
  const report: Record<string, unknown> = {
    baselineRef,
    command: "node_modules/.bin/vp run typecheck",
    candidate: "same checkout and installed dependencies for both runs",
    sampleIntervalMs,
    rssMetric: "peak aggregate VmRSS of the captured command PID and its transitive descendants",
  };
  let failed = false;
  try {
    const commit = resolveBaselineCommit(root, baselineRef);
    report.baselineCommit = commit;
    const effectCompilerPath = NodeFS.realpathSync(getExePath());
    report.effectCompilerPath = effectCompilerPath;
    const workspaces = discoverWorkspaces(root);
    const { baselineScripts, baselineWorkspacePaths } = loadBaselineScripts(
      root,
      commit,
      workspaces,
    );
    const plan = planBaselineTypecheckScripts(
      workspaces,
      baselineScripts,
      baselineWorkspacePaths,
      effectCompilerPath,
    );
    report.scriptCoverage = plan.notes;
    report.compilerMapping = plan.compilerMappings;
    const mappedCommands = plan.compilerMappings.reduce(
      (total, mapping) => total + mapping.commandCount,
      0,
    );
    report.baselineLabel = `baseline scripts, ${mappedCommands} tsc commands in ${plan.compilerMappings.length} workspaces mapped to Effect tsgo`;
    const before = await withTemporaryTypecheckScripts(root, workspaces, plan.overrides, () =>
      runTypecheck(root, interrupts.signal),
    );
    runs.push(before);
    const after = await runTypecheck(root, interrupts.signal);
    runs.push(after);
    report.runs = [
      { scriptSet: report.baselineLabel, ...before },
      { scriptSet: "candidate scripts", ...after },
    ];
    failed = [before, after].some((run) => run.exitCode !== 0 || run.signal !== null);
  } catch (error) {
    report.error = errorMessage(error);
    failed = true;
    if (error instanceof BenchmarkInterrupted)
      process.exitCode = error.signalName === "SIGTERM" ? 143 : 130;
    else process.stderr.write(`typecheck benchmark failed: ${errorMessage(error)}\n`);
  } finally {
    interrupts.dispose();
  }

  if (runs.length && !report.runs)
    report.runs = runs.map((run, index) => ({
      scriptSet: index === 0 ? report.baselineLabel : "candidate scripts",
      ...run,
    }));
  emitReport(report, runs, baselineRef);
  if (failed && process.exitCode === undefined) process.exitCode = 1;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`typecheck benchmark failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
