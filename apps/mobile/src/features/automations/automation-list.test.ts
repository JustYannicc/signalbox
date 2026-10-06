import type { Automation, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newAutomationProject } from "./automation-list";

const automation = (overrides: Partial<Automation>): Automation => ({
  id: "a1",
  name: "Triage",
  description: null,
  intent: null,
  enabled: true,
  version: 1,
  draftVersion: null,
  projectId: "p1" as ProjectId,
  triggers: [],
  nextRunAt: null,
  webhookPath: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastRun: null,
  waiting: [],
  ...overrides,
});

const run = (startedAt: string) => ({
  id: `r-${startedAt}`,
  automationId: "a1",
  version: 1,
  status: "succeeded" as const,
  trigger: "manual" as const,
  startedAt,
  finishedAt: startedAt,
  error: null,
  errorDetail: null,
  waitingOnYou: false,
  title: null,
  retryOf: null,
});

describe("newAutomationProject", () => {
  const env = "env" as EnvironmentId;
  const projects = [
    { environmentId: env, id: "p1" as ProjectId },
    { environmentId: env, id: "p2" as ProjectId },
  ];

  it("prefers the project of the automation that ran last", () => {
    const entries = [
      { environmentId: env, automation: automation({ lastRun: run("2026-03-01T00:00:00Z") }) },
      {
        environmentId: env,
        automation: automation({
          projectId: "p2" as ProjectId,
          lastRun: run("2026-03-05T00:00:00Z"),
        }),
      },
    ];
    expect(newAutomationProject(entries, projects, new Set([env]))).toEqual({
      environmentId: env,
      projectId: "p2",
    });
  });

  it("falls back to a project on a connected environment, or nothing", () => {
    const gone = [
      { environmentId: env, automation: automation({ projectId: "missing" as ProjectId }) },
    ];
    expect(newAutomationProject(gone, projects, new Set([env]))?.projectId).toBe("p1");
    expect(newAutomationProject([], projects, new Set())).toBeNull();
  });
});
