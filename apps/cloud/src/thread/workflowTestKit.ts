import type { RetainedWorkflowScript } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ThreadEngine } from "./ThreadEngine.ts";
import { nodeEvent, type DecisionContext } from "./threadEvents.ts";
import { workflowEvent } from "./workflowControl.ts";

export const coordinatorId = NodeId.make("workflow-one");
export const siblingId = NodeId.make("workflow-two");
export const childId = NodeId.make("workflow-phase");
export const scriptPath = "/workflows/review.js";

export const workflowFixture = (
  projection: OrchestrationV2ThreadProjection,
  ctx: DecisionContext,
) => {
  const run = projection.runs[0]!;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  )!;
  const root = projection.nodes.find((node) => node.id === run.rootNodeId)!;
  const task = (id: NodeId, parentNodeId: NodeId, workflow = true): OrchestrationV2Subagent => ({
    id,
    threadId: projection.thread.id,
    runId: run.id,
    parentNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: providerThread.driver,
    providerInstanceId: run.providerInstanceId,
    providerThreadId: run.providerThreadId,
    childThreadId: null,
    nativeTaskRef: { driver: providerThread.driver, nativeId: `native:${id}`, strength: "strong" },
    prompt: "Review this change",
    title: "Review",
    model: null,
    status: "running",
    result: null,
    startedAt: ctx.now,
    completedAt: null,
    updatedAt: ctx.now,
    ...(workflow
      ? {
          workflow: {
            phases: [{ index: 0, title: "Review" }],
            agents: [{ index: 0, label: "Reviewer", state: "running", agentId: childId }],
            runHandles: { scriptPath, scriptRevision: `revision:${id}` },
          },
        }
      : {}),
  });
  const tasks = [
    task(coordinatorId, root.id),
    task(childId, coordinatorId, false),
    task(siblingId, root.id),
  ];
  const scripts: ReadonlyArray<RetainedWorkflowScript> = tasks
    .filter((each) => each.workflow !== undefined)
    .map((each) => ({
      subagentId: each.id,
      runId: run.id,
      scriptPath,
      revision: `revision:${each.id}`,
      contents: `// exact ${each.id}\nawait review();`,
      truncated: false,
    }));
  return {
    tasks,
    scripts,
    events: tasks.flatMap((each) => [
      workflowEvent(ctx, each),
      nodeEvent(ctx, {
        ...root,
        id: each.id,
        parentNodeId: each.parentNodeId,
        kind: "subagent",
        status: "running",
      }),
    ]),
  };
};

export const seedWorkflows = ThreadEngine.use((engine) =>
  engine.apply((projection, ctx) => {
    if (projection === null) throw new Error("Launch the thread before seeding workflows.");
    const fixture = workflowFixture(projection, ctx);
    return Effect.succeed({ events: fixture.events, scripts: fixture.scripts, result: fixture });
  }),
);
