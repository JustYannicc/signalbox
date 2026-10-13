/**
 * PLACEHOLDER DATA: what the fixture threads, automations and level agents
 * spent in the last 30 days (API-equivalent, like the Tokens view). Real usage
 * is counted per provider and model from transcripts and doesn't know which
 * thread or project it came from yet, so nothing here is live. Numbers are
 * round so the rollup is easy to check by eye: merchant-portal $24 and
 * terminal-app $12 plus Northwind's own $16 make Northwind team $52.
 * Delete once turns record their cost with their thread.
 */
import type { PoolHarness } from "../accounts/accountPoolsModel";
import { AUTOMATIONS } from "../homeAutomations/automationFixtures";
import { TOP_LEVEL, type LevelKey } from "../levels/levels";
import { TEAM_THREADS } from "../multiplayer/multiplayerFixtures";
import { automationHomeTarget } from "../sidebar/sections/mappedItems";
import { LOOSE_ITEMS } from "../sidebar/sections/sectionModel";
import type { HomeTarget } from "../spaces/spacesMappings";
import type { CostEntryKind } from "./levelCosts";

export const LEVEL_COST_WINDOW_LABEL = "Last 30 days";

export interface CostFixture {
  readonly id: string;
  readonly kind: CostEntryKind;
  readonly label: string;
  /** Where it sits unless you moved it in Home. */
  readonly home: HomeTarget;
  readonly harness: PoolHarness;
  readonly usd: number;
}

const looseThread = (id: string, harness: PoolHarness, usd: number): CostFixture => {
  const item = LOOSE_ITEMS.find((entry) => entry.id === id);
  return {
    id,
    kind: "thread",
    label: item?.title ?? id,
    home: item?.sectionId ? `section:${item.sectionId}` : TOP_LEVEL,
    harness,
    usd,
  };
};

const teamThread = (id: string, harness: PoolHarness, usd: number): CostFixture => {
  const thread = TEAM_THREADS.find((entry) => entry.id === id);
  return {
    id,
    kind: "thread",
    label: thread?.title ?? id,
    home: `team-project:${thread?.projectId ?? "merchant-portal"}`,
    harness,
    usd,
  };
};

const automation = (id: string, harness: PoolHarness, usd: number): CostFixture => ({
  id,
  kind: "automation",
  label: AUTOMATIONS.find((entry) => entry.id === id)?.name ?? id,
  home: automationHomeTarget(id),
  harness,
  usd,
});

/** A level agent coordinating what's below it: briefings, routing, asks answered. */
const agentWork = (level: LevelKey, label: string, harness: PoolHarness, usd: number) => ({
  id: `agent:${level}`,
  kind: "agent" as const,
  label,
  home: level,
  harness,
  usd,
});

export const LEVEL_COST_FIXTURES: readonly CostFixture[] = [
  // Top level ($14): Appa and the rules that apply to everything below.
  agentWork(TOP_LEVEL, "Appa: briefings, capture, answering asks", "claude", 8),
  looseThread("chat-schema-question", "claude", 2),
  automation("capture-routing", "codex", 2),
  automation("danger-check", "claude", 1.5),
  automation("no-force-push", "codex", 0.5),

  // Work's own ($17). Work has no pool of its own, so this falls through to yours.
  agentWork("section:work", "Work agent: coordinating Work", "claude", 2),
  looseThread("chat-okr-draft", "claude", 3),
  looseThread("task-expense-report", "codex", 2),
  automation("reconcile-card-bill", "codex", 4),
  automation("monthly-expenses", "codex", 3),
  automation("notion-digest", "claude", 3),

  // Northwind team's own ($16), paid by the Northwind pools.
  agentWork("section:work-northwind", "Northwind agent: coordinating the team", "claude", 3),
  looseThread("chat-terminal-rollout", "claude", 1),
  automation("customer-replies", "codex", 12),

  // merchant-portal ($24): its own Codex pool beats Northwind's; Claude still comes from Northwind.
  teamThread("mp-refund-webhooks", "codex", 18),
  teamThread("mp-payout-copy", "claude", 4),
  teamThread("mp-settlement-pagination", "codex", 2),

  // terminal-app ($12): no pool of its own, so Northwind's; Grok reaches down from your top level.
  teamThread("ta-printer-fix", "codex", 10),
  teamThread("ta-neptune-questions", "claude", 1),
  teamThread("ta-offline-mode", "grok", 1),

  // Personal ($9).
  agentWork("section:personal", "Personal agent: coordinating Personal", "claude", 1),
  looseThread("chat-lisbon", "claude", 1),
  looseThread("task-tax-return", "codex", 5),
  automation("integration-health", "codex", 1),
  automation("work-out-of-sight", "claude", 0.5),
  automation("water-plants", "claude", 0.5),

  // Your signalbox project ($60), wherever Home put it (Personal when it isn't found).
  automation("review-prs", "codex", 22),
  automation("sync-upstream", "codex", 14),
  automation("spec-to-pr", "codex", 12),
  automation("ship-change", "codex", 6),
  automation("sentry-feedback-fix", "codex", 4),
  automation("triage-sentry", "codex", 2),
];
