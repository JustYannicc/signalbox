import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { cruise, getAvailableTranspilers } from "dependency-cruiser";

import config from "../../.dependency-cruiser.cjs";
import { checkBaseline, violationKey } from "./baseline.mjs";
import { readWorkspaces, workspaceAliases, workspaceViolations } from "./workspaces.mjs";

const ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const BASELINE = "scripts/boundaries/baseline.json";
const git = (args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();

async function main() {
  process.chdir(ROOT);
  const { values } = NodeUtil.parseArgs({
    options: {
      upstream: { type: "string", default: "upstream/main" },
      base: { type: "string", default: "origin/main" },
      "write-baseline": { type: "boolean", default: false },
    },
  });
  // The merge check uses this ref too. Missing upstream is a setup error, never a downgrade.
  const upstream = git(["rev-parse", "--verify", values.upstream]);
  const upstreamFiles = new Set(git(["ls-tree", "-r", "--name-only", upstream]).split("\n"));
  const files = [...new Set(git(["ls-files", "-c", "-o", "--exclude-standard"]).split("\n"))];
  const workspaces = readWorkspaces(files);
  const inputs = files.filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      !file.includes("/deps/") &&
      workspaces.some((workspace) => file.startsWith(`${workspace.directory}/`)) &&
      NodeFS.existsSync(file),
  );
  if (!getAvailableTranspilers().some((item) => item.name === "typescript" && item.available)) {
    throw new Error(
      "The compatible TypeScript parser is required to scan TypeScript, including type-only imports. Run vp i.",
    );
  }
  const { output } = await cruise(
    inputs,
    {
      ...config.options,
      validate: true,
      ruleSet: { forbidden: config.forbidden },
      outputType: "json",
    },
    {
      alias: { ...workspaceAliases(workspaces), "~": NodePath.join(ROOT, "apps/web/src") },
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
        ".mjs": [".mts", ".mjs"],
        ".cjs": [".cts", ".cjs"],
      },
    },
  );
  const graph = typeof output === "string" ? JSON.parse(output) : output;
  if (
    !graph.modules.some((module) => module.source.endsWith(".ts") && module.dependencies.length)
  ) {
    throw new Error("No TypeScript dependencies were scanned.");
  }
  const violations = [
    ...graph.summary.violations,
    ...workspaceViolations(graph.modules, workspaces),
  ].map((violation) => ({
    ...violation,
    severity: [violation.from, ...(violation.cycle ?? []).map((item) => item.name)].every((file) =>
      upstreamFiles.has(file),
    )
      ? "warn"
      : "error",
  }));
  const errors = violations.filter((violation) => violation.severity === "error");
  const base = git(["merge-base", "HEAD", values.base]);
  const hasBaseline = git(["ls-tree", "--name-only", base, "--", BASELINE]).length > 0;
  const previousText = hasBaseline ? git(["show", `${base}:${BASELINE}`]) : undefined;
  const previous = previousText ? JSON.parse(previousText).violations : undefined;
  if (values["write-baseline"]) {
    const entries = [...new Set(errors.map(violationKey))].sort();
    const growth = checkBaseline(entries, previous);
    if (growth.length) throw new Error(growth.join("\n"));
    NodeFS.writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          comment:
            "Existing fork leaks get fixed as PRs touch them. This list can only shrink relative to the PR base.",
          violations: entries,
        },
        null,
        2,
      )}\n`,
    );
  }
  const baseline = JSON.parse(NodeFS.readFileSync(BASELINE, "utf8")).violations;
  const baselineErrors = checkBaseline(baseline, previous);
  const known = new Set(baseline);
  let errorCount = baselineErrors.length;
  let warningCount = 0;
  let knownCount = 0;
  for (const violation of violations) {
    if (violation.severity === "error" && known.has(violationKey(violation))) {
      knownCount++;
      continue;
    }
    if (violation.severity === "error") errorCount++;
    else warningCount++;
    console.log(
      `${violation.severity} ${violation.rule.name}: ${violation.from} -> ${violation.to}`,
    );
  }
  for (const message of baselineErrors) console.error(`error ${message}`);
  console.log(
    `Boundaries: ${errorCount} errors, ${warningCount} upstream warnings, ${knownCount} baselined fork violations; ${graph.modules.length} modules scanned. Upstream ${upstream.slice(0, 12)}.`,
  );
  process.exitCode = errorCount ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
