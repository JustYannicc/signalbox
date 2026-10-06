import type {
  Automation,
  AutomationRunSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionFeed,
  automationSubtitle,
  canRetryRun,
  filterAutomations,
  needsAttention,
  runActions,
  sortAutomations,
} from "./list.ts";

const lastRun = (status: AutomationRunSummary["status"], startedAt: string) =>
  ({
    id: `run-${startedAt}`,
    automationId: "a",
    version: 1,
    status,
    trigger: "cron",
    startedAt,
    finishedAt: null,
    error: null,
    errorDetail: null,
    waitingOnYou: false,
    title: null,
    retryOf: null,
  }) satisfies AutomationRunSummary;

const automation = (name: string, overrides: Partial<Automation> = {}): Automation => ({
  id: name,
  name,
  description: null,
  intent: null,
  enabled: true,
  version: 1,
  draftVersion: null,
  projectId: "p" as ProjectId,
  triggers: [],
  nextRunAt: null,
  webhook: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastRun: null,
  waiting: [],
  ...overrides,
});

const entry = (value: Automation) => ({ environmentId: "env" as EnvironmentId, automation: value });

const question = (since: string) => ({
  runId: "r",
  stepKey: "s1",
  label: "Send it?",
  question: null,
  options: ["approve", "reject"],
  multi: false,
  fields: [],
  since,
});

const entries = [
  entry(automation("Quiet", { lastRun: lastRun("succeeded", "2026-02-03T00:00:00.000Z") })),
  entry(automation("Broken", { lastRun: lastRun("failed", "2026-02-01T00:00:00.000Z") })),
  entry(automation("Asking", { waiting: [question("2026-01-05T00:00:00.000Z")] })),
  entry(automation("Recent", { lastRun: lastRun("succeeded", "2026-02-04T00:00:00.000Z") })),
];

const names = (list: ReadonlyArray<{ automation: Automation }>) =>
  list.map((item) => item.automation.name);

describe("sortAutomations", () => {
  it("puts what needs you first, then the most recent activity", () => {
    expect(names(sortAutomations(entries, "attention"))).toEqual([
      "Asking",
      "Broken",
      "Recent",
      "Quiet",
    ]);
  });

  it("sorts by name", () => {
    expect(names(sortAutomations(entries, "name"))).toEqual([
      "Asking",
      "Broken",
      "Quiet",
      "Recent",
    ]);
  });
});

describe("filterAutomations", () => {
  it("keeps only what needs you, and matches the query against name and description", () => {
    expect(names(filterAutomations(entries, { query: "", onlyNeedsYou: true }))).toEqual([
      "Broken",
      "Asking",
    ]);
    expect(names(filterAutomations(entries, { query: " rec ", onlyNeedsYou: false }))).toEqual([
      "Recent",
    ]);
  });
});

describe("attentionFeed", () => {
  it("lists every waiting question and every latest run that failed", () => {
    const feed = attentionFeed(entries);
    expect(feed.questions.map((item) => item.entry.automation.name)).toEqual(["Asking"]);
    expect(names(feed.failed)).toEqual(["Broken"]);
    expect(needsAttention(entries[0]!.automation)).toBe(false);
  });
});

describe("automationSubtitle", () => {
  const next = (iso: string) => `Next run ${iso}`;

  it("says Paused, then the next run, then what starts it", () => {
    expect(
      automationSubtitle({ enabled: false, nextRunAt: "2026-01-01", triggers: [] }, next),
    ).toBe("Paused");
    expect(automationSubtitle({ enabled: true, nextRunAt: "2026-01-01", triggers: [] }, next)).toBe(
      "Next run 2026-01-01",
    );
    expect(
      automationSubtitle({ enabled: true, nextRunAt: null, triggers: [{ webhook: true }] }, next),
    ).toBe("When a webhook arrives");
  });
});

describe("runActions", () => {
  const webhookOnly = { triggers: [{ webhook: true as const }] };

  it("leads a webhook-only automation with replaying the shown run", () => {
    expect(runActions(webhookOnly, { input: { id: 1 } })).toEqual({
      lead: { id: "replay", title: "Replay this run", input: { id: 1 } },
      extra: { id: "run", title: "Run now without input" },
    });
    expect(runActions(webhookOnly, null)).toEqual({
      lead: { id: "run", title: "Run now without input" },
      extra: null,
    });
    // A run that had no input replays with none.
    expect(runActions(webhookOnly, { input: null }).lead).toEqual({
      id: "replay",
      title: "Replay this run",
    });
  });

  it("leads others with Run now and offers the shown run's input when it had one", () => {
    expect(runActions({ triggers: [] }, { input: null })).toEqual({
      lead: { id: "run", title: "Run now" },
      extra: null,
    });
    expect(runActions({ triggers: [] }, { input: "hi" }).extra).toEqual({
      id: "replay",
      title: "Run again with this run's input",
      input: "hi",
    });
  });

  it("retries only failed and cancelled runs", () => {
    expect(canRetryRun({ status: "failed" })).toBe(true);
    expect(canRetryRun({ status: "cancelled" })).toBe(true);
    expect(canRetryRun({ status: "running" })).toBe(false);
  });
});
