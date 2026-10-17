import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { getAvailableTranspilers } from "dependency-cruiser";

import { checkBaseline, unrecordedBaseCycles, violationKey } from "./baseline.mjs";
import { scanBase } from "./base.mjs";
import { scanGraph } from "./graph.mjs";
import { readUpstreamSource } from "./upstream.mjs";

const ROOT = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const BASELINE = "scripts/boundaries/baseline.json";

export async function checkBoundaries(root, values) {
  const git = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).trimEnd();
  // Missing upstream is a setup error, never a downgrade.
  const upstream = readUpstreamSource(git, values.upstream);
  const files = [...new Set(git(["ls-files", "-c", "-o", "--exclude-standard"]).split("\n"))];
  if (!getAvailableTranspilers().some((item) => item.name === "typescript" && item.available)) {
    throw new Error(
      "The compatible TypeScript parser is required to scan TypeScript, including type-only imports. Run vp i.",
    );
  }
  const graph = await scanGraph(root, files);
  const violations = graph.violations.map((violation) => ({
    ...violation,
    severity: upstream.files.has(violation.from) ? "warn" : "error",
  }));
  const errors = violations.filter((violation) => violation.severity === "error");
  const base = git(["merge-base", "HEAD", values.base]);
  const hasBaseline = git(["ls-tree", "--name-only", base, "--", BASELINE]).length > 0;
  const previousText = hasBaseline ? git(["show", `${base}:${BASELINE}`]) : undefined;
  const previous = previousText ? JSON.parse(previousText).violations : undefined;
  const legacy = unrecordedBaseCycles(
    previous ? (await scanBase(root, base)).violations : [],
    previous,
  );
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
    NodeFS.readFileSync(NodePath.join(root, BASELINE), "utf8"),
  ).violations;
  const baselineErrors = checkBaseline(baseline, previous, errors.map(violationKey));
  const known = new Set(baseline);
  let errorCount = baselineErrors.length;
  let warningCount = 0;
  let knownCount = 0;
  let legacyCount = 0;
  for (const violation of violations) {
    if (violation.severity === "error" && known.has(violationKey(violation))) {
      knownCount++;
      continue;
    }
    if (violation.severity === "error" && legacy.has(violationKey(violation))) {
      legacyCount++;
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
    `Boundaries: ${errorCount} errors, ${warningCount} upstream warnings, ${knownCount} baselined fork violations, ${legacyCount} unrecorded base cycle edges; ${graph.modules.length} modules scanned. Upstream ${upstream.commit.slice(0, 12)}.`,
  );
  return errorCount ? 1 : 0;
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      upstream: { type: "string", default: "upstream/main" },
      base: { type: "string", default: "origin/main" },
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
