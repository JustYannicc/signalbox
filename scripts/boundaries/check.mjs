import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { getAvailableTranspilers } from "dependency-cruiser";

import { checkBaseline, unrecordedBaseCycles, violationKey } from "./baseline.mjs";
import { scanBase } from "./base.mjs";
import { mergedHead } from "../upstream-sync/mergeTree.ts";
import { scanGraph } from "./graph.mjs";
import { readUpstreamSource, sourceOwnership } from "./upstream.mjs";

const ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const BASELINE = "scripts/boundaries/baseline.json";
// Never advance this migration source: doing so would forgive cycles introduced after #850.
const LEGACY_CYCLE_BASE = "7eaa0c3a37b93ba2673899e3250cd3baaa2c8dc6";

export async function checkBoundaries(root, values, legacyBase = LEGACY_CYCLE_BASE) {
  const git = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).trimEnd();
  const base = values.head
    ? git(["rev-parse", `${values.base}^{commit}`])
    : git(["merge-base", "HEAD", values.base]);
  if (values.head && values["write-baseline"]) {
    throw new Error("Update the baseline in the working tree, without --head.");
  }
  // merge-tree computes the PR's merge base with the current target, including
  // target changes made since the run was queued. Historical debt comes from that target.
  const candidate = values.head ? mergedHead(root, base, values.head) : undefined;
  // Missing upstream is a setup error, never a downgrade.
  const upstream = readUpstreamSource(git, values.upstream, candidate);
  const files = [...new Set(git(["ls-files", "-c", "-o", "--exclude-standard"]).split("\n"))];
  if (!getAvailableTranspilers().some((item) => item.name === "typescript" && item.available)) {
    throw new Error(
      "The compatible TypeScript parser is required to scan TypeScript, including type-only imports. Run vp i.",
    );
  }
  const graph = candidate ? await scanBase(root, candidate) : await scanGraph(root, files);
  const violations = graph.violations
    .filter((violation) => sourceOwnership(upstream, violation.from) !== "vendored")
    .map((violation) => ({
      ...violation,
      severity: sourceOwnership(upstream, violation.from) === "upstream" ? "warn" : "error",
    }));
  const errors = violations.filter((violation) => violation.severity === "error");
  const hasBaseline = git(["ls-tree", "--name-only", base, "--", BASELINE]).length > 0;
  const previousText = hasBaseline ? git(["show", `${base}:${BASELINE}`]) : undefined;
  const previous = previousText ? JSON.parse(previousText).violations : undefined;
  let legacy = new Set();
  const inherited = new Set();
  if (previous) {
    const baseGraph = await scanBase(root, base);
    if (candidate) {
      // Unrelated PRs must not inherit new main failures. Main itself remains strict,
      // and deleting a recorded exemption still requires fixing its violation.
      for (const violation of baseGraph.violations) {
        const key = violationKey(violation);
        if (sourceOwnership(upstream, violation.from) === "fork" && !previous.includes(key)) {
          inherited.add(key);
        }
      }
    }
    const legacyGraph = base === legacyBase ? baseGraph : await scanBase(root, legacyBase);
    const legacyBaseline = JSON.parse(git(["show", `${legacyBase}:${BASELINE}`])).violations;
    legacy = unrecordedBaseCycles(
      baseGraph.violations,
      previous,
      legacyGraph.violations,
      legacyBaseline,
    );
  }
  if (values["write-baseline"]) {
    const entries = [...new Set(errors.map(violationKey))].filter((key) => !legacy.has(key)).sort();
    const growth = checkBaseline(entries, previous);
    if (growth.length) throw new Error(growth.join("\n"));
    NodeFS.writeFileSync(
      NodePath.join(root, BASELINE),
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
  const baseline = JSON.parse(
    candidate
      ? git(["show", `${candidate}:${BASELINE}`])
      : NodeFS.readFileSync(NodePath.join(root, BASELINE), "utf8"),
  ).violations;
  const baselineErrors = checkBaseline(baseline, previous, errors.map(violationKey));
  const known = new Set(baseline);
  let errorCount = baselineErrors.length;
  let warningCount = 0;
  let knownCount = 0;
  let legacyCount = 0;
  let inheritedCount = 0;
  for (const violation of violations) {
    if (violation.severity === "error" && known.has(violationKey(violation))) {
      knownCount++;
      continue;
    }
    if (violation.severity === "error" && legacy.has(violationKey(violation))) {
      legacyCount++;
      continue;
    }
    if (violation.severity === "error" && inherited.has(violationKey(violation))) {
      inheritedCount++;
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
    `Boundaries: ${errorCount} errors, ${warningCount} upstream warnings, ${knownCount} baselined fork violations, ${legacyCount} unrecorded base cycle edges, ${inheritedCount} inherited target violations; ${graph.modules.length} modules scanned. Upstream ${upstream.commit.slice(0, 12)}.`,
  );
  return errorCount ? 1 : 0;
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      upstream: { type: "string", default: "upstream/main" },
      base: { type: "string", default: "origin/main" },
      head: { type: "string" },
      "write-baseline": { type: "boolean", default: false },
    },
  });
  checkBoundaries(ROOT, values).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
