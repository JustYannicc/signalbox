// @effect-diagnostics nodeBuiltinImport:off - compares native compiler processes in CI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const platform = Effect.runSync(HostProcess.Platform);
const architecture = Effect.runSync(HostProcess.Architecture);
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const require = NodeModule.createRequire(import.meta.url);

export function diagnostics(output: string) {
  output = output.replaceAll("\r\n", "\n");
  const records = [];
  const matches = [
    ...output.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): /gm),
  ];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    records.push({
      file: match[1]!.replaceAll("\\", "/"),
      line: Number(match[2]),
      column: Number(match[3]),
      category: match[4]!,
      code: Number(match[5]),
      message: output.slice(match.index! + match[0].length, matches[i + 1]?.index).trim(),
    });
  }
  // Project/config errors have no source location. Never let them compare as an empty success.
  for (const match of output.matchAll(/^(error|warning|suggestion|message) TS(\d+): (.+)$/gm)) {
    records.push({
      file: "",
      line: 0,
      column: 0,
      category: match[1]!,
      code: Number(match[2]),
      message: match[3]!,
    });
  }
  return records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function compareDiagnostics(declared: string, effect: string, rust: string) {
  const actual = diagnostics(rust);
  const expected = [
    ...diagnostics(declared).filter(
      (diagnostic) => diagnostic.code < 377000 || diagnostic.code >= 378000,
    ),
    ...diagnostics(effect).filter(
      (diagnostic) => diagnostic.code >= 377000 && diagnostic.code < 378000,
    ),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { expected, actual, equal: JSON.stringify(expected) === JSON.stringify(actual) };
}

export function compilerProjects(directory: string, command: string) {
  const result = [];
  for (const part of command.split(" && ")) {
    // Cloud generates compiler assets and its probe before checking both compiler configs.
    if (
      directory === "apps/cloud" &&
      (part === "node infra/automationCompiler/prepare.ts" ||
        part === "node infra/syncProbe/prepare.mjs")
    )
      continue;
    const match = /^(?:tsc|tsc-rs) --noEmit(?: -p (\S+))?$/.exec(part);
    if (!match) throw new Error(`Unrecognized typecheck in ${directory}: ${part}`);
    result.push(NodePath.posix.join(directory, match[1] ?? "tsconfig.json"));
  }
  return result;
}

function projects() {
  const result = [];
  for (const parent of ["apps", "packages", "infra", "."]) {
    const directories =
      parent === "."
        ? ["scripts", "oxlint-plugin-t3code"]
        : NodeFS.readdirSync(NodePath.join(root, parent)).map((name) => `${parent}/${name}`);
    for (const directory of directories) {
      const manifest = NodePath.join(root, directory, "package.json");
      if (!NodeFS.existsSync(manifest)) continue;
      const command = JSON.parse(NodeFS.readFileSync(manifest, "utf8")).scripts?.typecheck;
      if (!command || command === "astro check") continue;
      result.push(...compilerProjects(directory, command));
    }
  }
  return result.sort();
}

function nativeCompiler(packageName: string, platformName: string) {
  const scoped = NodeModule.createRequire(require.resolve(`${packageName}/package.json`));
  return NodePath.join(
    NodePath.dirname(scoped.resolve(`${platformName}/package.json`)),
    "lib",
    platform === "win32" ? "tsc.exe" : "tsc",
  );
}

export function assertUnpatchedCompiler(compiler: string) {
  // Effect can replace a binary without changing its version, retaining this backup.
  if (
    [compiler, NodeFS.realpathSync(compiler)].some((path) => NodeFS.existsSync(`${path}.original`))
  )
    throw new Error(
      "The declared TypeScript binary has an Effect patch backup. Use --typescript with an unmodified declared compiler.",
    );
}

export function runCompiler(compiler: string, project: string) {
  const started = performance.now();
  const measurement = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compiler-parity-"));
  const stats = NodePath.join(measurement, "time.txt");
  // Composite projects require incremental checking; isolate build state so every run is fresh.
  const args = [
    "--noEmit",
    "--pretty",
    "false",
    "--incremental",
    "true",
    "--tsBuildInfoFile",
    NodePath.join(measurement, "build.tsbuildinfo"),
    "-p",
    project,
  ];
  try {
    // GNU time records the compiler's RSS, rather than this Node process or a polling estimate.
    const measured = platform === "linux";
    const result = NodeChildProcess.spawnSync(
      measured ? "/usr/bin/time" : compiler,
      measured ? ["-f", "%M", "-o", stats, compiler, ...args] : args,
      { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180_000 },
    );
    if (result.error) throw result.error;
    if (result.signal || (result.status !== 0 && result.status !== 1 && result.status !== 2))
      throw new Error(
        `${project}: compiler failed (${result.status}, ${result.signal})\n${result.stderr}`,
      );
    const output = result.stdout + result.stderr;
    if (result.status !== 0 && diagnostics(output).length === 0)
      throw new Error(`${project}: compiler failed without diagnostics\n${output}`);
    return {
      output,
      status: result.status,
      seconds: (performance.now() - started) / 1000,
      peakKiB: measured
        ? Number(NodeFS.readFileSync(stats, "utf8").trim().split("\n").at(-1))
        : null,
    };
  } finally {
    NodeFS.rmSync(measurement, { recursive: true, force: true });
  }
}

function main(args: string[]) {
  const baselineIndex = args.indexOf("--typescript");
  const override = baselineIndex < 0 ? undefined : args.splice(baselineIndex, 2)[1];
  const selected = args.length === 1 && args[0] === "--all" ? projects() : args;
  if (selected.length === 0 || selected.some((project) => project.startsWith("--")))
    throw new Error(
      "Usage: typecheck-parity.ts [--typescript <pristine-binary>] <tsconfig...> | --all",
    );
  const declared =
    override ?? nativeCompiler("typescript", `@typescript/typescript-${platform}-${architecture}`);
  const rust = nativeCompiler("tsc-rs", `@tsc-rs/${platform}-${architecture}`);
  // Resolve the matching Effect build without ever patching the declared compiler's shared package.
  const effect = require("@effect/tsgo/lib/getExePath").default();
  const version = JSON.parse(
    NodeFS.readFileSync(require.resolve("typescript/package.json"), "utf8"),
  ).version;
  assertUnpatchedCompiler(declared);
  const reported = NodeChildProcess.execFileSync(declared, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (reported !== `Version ${version}`)
    throw new Error(
      `Expected pristine TypeScript ${version}, got ${reported}. Use --typescript with an unmodified declared compiler.`,
    );
  const totals = {
    declared: { seconds: 0, peakKiB: 0 },
    effect: { seconds: 0, peakKiB: 0 },
    rust: { seconds: 0, peakKiB: 0 },
  };
  let failed = false;
  for (const project of selected) {
    const before = runCompiler(declared, project);
    const plugin = runCompiler(effect, project);
    const after = runCompiler(rust, project);
    for (const [name, result] of [
      ["declared", before],
      ["effect", plugin],
      ["rust", after],
    ] as const) {
      totals[name].seconds += result.seconds;
      totals[name].peakKiB = Math.max(totals[name].peakKiB, result.peakKiB ?? 0);
    }
    const compared = compareDiagnostics(before.output, plugin.output, after.output);
    const passed =
      compared.equal && before.status === 0 && plugin.status === 0 && after.status === 0;
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${project}\n`);
    if (!passed) {
      failed = true;
      process.stderr.write(
        JSON.stringify(
          { project, statuses: [before.status, plugin.status, after.status], ...compared },
          null,
          2,
        ) + "\n",
      );
    }
  }
  const summary = `Sequential compiler parity, ${selected.length} projects. Peak RSS is the maximum single compiler process.\n\n| Compiler | Wall seconds | Peak RSS KiB |\n| --- | ---: | ---: |\n${Object.entries(
    totals,
  )
    .map(
      ([name, metric]) =>
        `| ${name} | ${metric.seconds.toFixed(2)} | ${metric.peakKiB || "unmeasured"} |`,
    )
    .join("\n")}\n`;
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
