// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone CI guard, run with plain node.
/**
 * Fails a deploy whose plan would replace, delete, orphan, unbind or retarget infrastructure:
 *
 *   node apps/cloud/infra/check-plan.ts <stage> <plan output file>
 *
 * The plan file is what `alchemy deploy --dry-run` printed. A run that printed
 * no plan fails too, so a crashed plan never reads as a safe one. In CI the
 * plan also goes to the job summary.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { type PlanReport, readPlan } from "./planCheck.ts";

function format(stage: string, report: PlanReport) {
  const rows = report.rows.map((row) => `${row.action.padEnd(8)} ${row.resource}`);
  return [`Plan for ${stage}: ${report.summary ?? "none (the dry run did not finish)"}`, ...rows];
}

function main(argv: ReadonlyArray<string>) {
  const [stage, file] = argv;
  if (stage === undefined || file === undefined) {
    throw new Error("Usage: check-plan.ts <stage> <plan output file>");
  }
  const report = readPlan(NodeUtil.stripVTControlCharacters(NodeFS.readFileSync(file, "utf8")));
  const lines = format(stage, report);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [`### Alchemy plan: \`${stage}\``, "```", ...lines, "```", ""].join("\n");
    NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  const problem =
    report.summary === null
      ? "No plan: the dry run did not finish."
      : report.blocking.length > 0
        ? `Refusing to deploy: ${report.blocking.map((row) => `${row.resource} (${row.action})`).join(", ")}.`
        : null;
  if (problem !== null) {
    console.log(`::error title=Alchemy plan (${stage})::${problem}`);
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
