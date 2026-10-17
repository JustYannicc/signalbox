/**
 * Reads the plan `alchemy deploy --dry-run` prints and says whether it may
 * deploy. A plan that replaces, deletes, orphans or unbinds anything fails:
 * for production that would recreate (and empty) a Worker's Durable Objects,
 * a container application or a bucket, or drop one from Alchemy's state.
 */
import { AUTOMATION_BINDINGS, DURABLE_OBJECT_BINDINGS } from "./stage.ts";

export const PLAN_ACTIONS = [
  "create",
  "update",
  "adopted",
  "noop",
  "replace",
  "delete",
  "orphaned",
  "unbind",
  "destroy",
  "rebind",
] as const;

export type PlanAction = (typeof PLAN_ACTIONS)[number];

const BLOCKING: ReadonlySet<PlanAction> = new Set([
  "replace",
  "delete",
  "orphaned",
  "unbind",
  "destroy",
  "rebind",
]);

// Alchemy prints a changed binding as `update`, even when it points at a
// different namespace or bucket. Those changes need the same review as a
// replacement. Vars and secrets can still update during an ordinary deploy.
const INFRASTRUCTURE_BINDINGS: ReadonlySet<string> = new Set([
  ...Object.keys(DURABLE_OBJECT_BINDINGS).map((name) => `Cloud/${name}`),
  "Cloud/DRIVE_PACKS",
  "Cloud/PREVIEW_DRIVE_PACKS",
  `Cloud/${AUTOMATION_BINDINGS.workflow}`,
  `Cloud/${AUTOMATION_BINDINGS.loader}`,
  "ModelGateway/GRANTS",
  "PoolContainer/POOLS",
  "ThreadContainer/THREADS",
  "AutomationRuns/Cloud",
  // Re-saving the alias replaces its frozen artifact despite an `update` action.
  "BoatRunnerSnapshot",
]);

export interface PlanRow {
  readonly resource: string;
  readonly action: PlanAction;
}

export interface PlanReport {
  /** The `Plan: …` summary line, or null when the output has none. */
  readonly summary: string | null;
  readonly rows: ReadonlyArray<PlanRow>;
  readonly blocking: ReadonlyArray<PlanRow>;
}

const ROW = new RegExp(`\\[([^\\[\\]]+)\\] (${PLAN_ACTIONS.join("|")})(?=\\s|$)`);
const SUMMARY = /\bPlan: (.*)$/;

/** `output` is plain text: strip terminal colors first. */
export const readPlan = (output: string): PlanReport => {
  let summary: string | null = null;
  const rows: Array<PlanRow> = [];
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    const summaryMatch = SUMMARY.exec(line);
    if (summaryMatch?.[1] !== undefined) {
      summary = summaryMatch[1];
      continue;
    }
    const row = ROW.exec(line);
    if (row?.[1] !== undefined && row[2] !== undefined) {
      rows.push({ resource: row[1], action: row[2] as PlanAction });
    }
  }
  return {
    summary,
    rows,
    blocking: rows.filter(
      (row) =>
        BLOCKING.has(row.action) ||
        (row.action === "update" && INFRASTRUCTURE_BINDINGS.has(row.resource)),
    ),
  };
};
