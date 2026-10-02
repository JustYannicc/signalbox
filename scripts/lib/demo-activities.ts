/**
 * Turns a demo thread into `projection_thread_activities` rows shaped like
 * the ones `ProviderRuntimeIngestion.runtimeEventToActivities` persists, so
 * the work log, Agents panel, todo list, context meter, and pending requests
 * render from the same payloads real sessions produce.
 */
import { formatTokens } from "@t3tools/shared/usageFormat";

import {
  DEMO_CONTEXT_WINDOW_BY_PROVIDER,
  type DemoSubagent,
  type DemoThread,
  type DemoTool,
} from "./demo-dataset.ts";

/** Minutes-ago bounds of one turn: asked at `start`, answered at `end`. */
export interface DemoTurnWindow {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface DemoActivity {
  readonly id: string;
  readonly turnIndex: number;
  readonly minutesAgo: number;
  readonly tone: "info" | "tool" | "approval" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)*\.\w+$/;
const SUBAGENT_SPAWN_AT = 0.3;

export const demoRequestId = (thread: DemoThread) => `${thread.id}-request`;

export function turnTools(thread: DemoThread, turnIndex: number): ReadonlyArray<DemoTool> {
  const exchange = thread.exchanges[turnIndex];
  const own = exchange && exchange.length === 3 ? exchange[2] : [];
  return turnIndex === thread.exchanges.length - 1 ? [...own, ...(thread.tools ?? [])] : own;
}

function toolActivity(
  toolCallId: string,
  tool: DemoTool,
): Pick<DemoActivity, "tone" | "kind" | "summary" | "payload"> {
  const command =
    typeof tool === "string" ? (tool.startsWith("Ran ") ? tool.slice(4) : null) : tool.command;
  if (command !== null) {
    const output = typeof tool === "string" ? undefined : tool.output;
    const exitCode = typeof tool === "string" ? undefined : tool.exitCode;
    const status = exitCode === undefined || exitCode === 0 ? "completed" : "failed";
    return {
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        toolCallId,
        status,
        title: "Ran command",
        detail: command,
        data: {
          item: {
            type: "commandExecution",
            id: toolCallId,
            command,
            status,
            ...(output === undefined ? {} : { aggregatedOutput: output }),
            ...(exitCode === undefined ? {} : { exitCode }),
          },
        },
      },
    };
  }
  const title = tool as string;
  const [verb, ...rest] = title.split(" ");
  const target = rest.join(" ");
  if ((verb === "Edited" || verb === "Created") && PATH_LIKE.test(target)) {
    return {
      tone: "tool",
      kind: "tool.completed",
      summary: "File change",
      payload: {
        itemType: "file_change",
        toolCallId,
        status: "completed",
        title: "File change",
        detail: target,
        data: {
          item: {
            type: "fileChange",
            id: toolCallId,
            status: "completed",
            changes: [{ path: target, kind: { type: verb === "Created" ? "add" : "update" } }],
          },
        },
      },
    };
  }
  if (verb === "Read" && PATH_LIKE.test(target)) {
    return {
      tone: "tool",
      kind: "tool.completed",
      summary: "Read",
      payload: {
        itemType: "dynamic_tool_call",
        toolCallId,
        status: "completed",
        title: "Read",
        detail: target,
        data: { toolName: "Read", input: { file_path: target } },
      },
    };
  }
  return {
    tone: "tool",
    kind: "tool.completed",
    summary: title,
    payload: { itemType: "dynamic_tool_call", toolCallId, status: "completed", title },
  };
}

/** Claude reports agents as local_agent tasks; Codex children as bypassed collab threads. */
function subagentActivities(
  thread: DemoThread,
  window: DemoTurnWindow,
  turnIndex: number,
): DemoActivity[] {
  const agents = thread.subagents ?? [];
  if (agents.length === 0) return [];
  const rows: DemoActivity[] = [];
  const isCodex = thread.provider === "codex";
  const span = window.startMinutes - window.endMinutes;
  const spawn = window.startMinutes - span * SUBAGENT_SPAWN_AT;
  const latest = window.endMinutes + span * 0.03;
  const push = (
    id: string,
    minutesAgo: number,
    kind: string,
    summary: string,
    payload: Record<string, unknown>,
    tone: DemoActivity["tone"] = "info",
  ) =>
    rows.push({
      id,
      turnIndex,
      minutesAgo: Math.max(latest, minutesAgo),
      tone,
      kind,
      summary,
      payload,
    });

  const workflow = thread.workflow;
  const phaseLengths = (workflow?.phases ?? []).map((_, phase) =>
    Math.max(0, ...agents.filter((agent) => agent.phase === phase).map((agent) => agent.minutes)),
  );
  const startOf = (agent: DemoSubagent, index: number) =>
    spawn -
    index * 0.05 -
    (agent.phase === undefined ? 0 : phaseLengths.slice(0, agent.phase).reduce((a, b) => a + b, 0));

  if (workflow) {
    const linkage = {
      taskType: "local_workflow",
      agentKind: "agent",
      title: workflow.name,
      workflowName: workflow.name,
      phases: workflow.phases.map((title, index) => ({ index, title })),
      toolUseId: `toolu_${workflow.id}`,
    };
    push(
      `${thread.id}:${workflow.id}:started`,
      spawn + 0.02,
      "task.started",
      "local_workflow task started",
      {
        taskId: workflow.id,
        detail: workflow.name,
        ...linkage,
      },
    );
    if (!agents.some((agent) => agent.status === "running")) {
      const end = Math.min(...agents.map((agent, index) => startOf(agent, index) - agent.minutes));
      push(`${thread.id}:${workflow.id}:completed`, end - 0.1, "task.completed", "Task completed", {
        taskId: workflow.id,
        status: "completed",
        summary: workflow.summary,
        detail: workflow.summary,
        ...linkage,
      });
    }
  }

  agents.forEach((agent, index) => {
    const taskId =
      workflow && agent.phase !== undefined ? `${workflow.id}:wf:${agent.id}` : agent.id;
    const start = startOf(agent, index);
    const settled = agent.status !== "running";
    const settleAt = start - agent.minutes;
    const progressAt = settled ? settleAt + Math.min(0.3, agent.minutes / 4) : latest;
    const linkage: Record<string, unknown> = isCodex
      ? {
          agentKind: "agent",
          title: agent.title,
          role: agent.role,
          model: agent.model,
          ...(agent.effort ? { effort: agent.effort } : {}),
          timelineBypass: true,
        }
      : {
          taskType: "local_agent",
          agentKind: "agent",
          title: agent.title,
          role: agent.role,
          model: agent.model,
          ...(agent.effort ? { effort: agent.effort } : {}),
          ...(workflow && agent.phase !== undefined
            ? {
                parentAgentId: workflow.id,
                workflowName: workflow.name,
                agentIndex: index,
                phaseIndex: agent.phase,
                phaseTitle: workflow.phases[agent.phase],
              }
            : { toolUseId: `toolu_${agent.id}` }),
        };
    const prefix = `${thread.id}:${taskId}`;
    push(
      `${prefix}:started`,
      start,
      "task.started",
      isCodex ? "Task started" : "local_agent task started",
      { taskId, detail: agent.title, ...linkage },
    );
    if (isCodex) {
      push(`${prefix}:running`, start - 0.02, "task.updated", "Task running", {
        taskId,
        status: "running",
        ...linkage,
      });
    }
    if (agent.progress || agent.lastTool) {
      push(`task-progress:${thread.id}:${taskId}`, progressAt, "task.progress", agent.title, {
        taskId,
        detail: agent.progress ?? agent.title,
        ...(agent.progress ? { summary: agent.progress } : {}),
        ...(agent.lastTool ? { lastToolName: agent.lastTool } : {}),
        ...linkage,
      });
    }
    push(
      `task-usage:${thread.id}:${taskId}`,
      progressAt - 0.01,
      "task.progress",
      "Task usage updated",
      {
        taskId,
        ...linkage,
        usageSnapshot: true,
        typedUsage: {
          totalTokens: agent.tokens,
          ...(agent.toolUses === undefined ? {} : { toolUses: agent.toolUses }),
          ...(settled ? { durationMs: Math.round(agent.minutes * 60_000) } : {}),
        },
      },
    );
    if (!settled && agent.lastTool) {
      push(`tool-progress:${thread.id}:${taskId}`, latest, "tool.progress", agent.lastTool, {
        taskId,
        toolName: agent.lastTool,
      });
    }
    if (!settled) return;
    const failed = agent.status === "failed";
    const outcome = failed ? agent.error : agent.result;
    if (isCodex) {
      const status = failed ? "failed" : "idle";
      push(
        `${prefix}:settled`,
        settleAt,
        "task.updated",
        failed ? "Task failed" : "Task idle",
        { taskId, status, ...(failed && agent.error ? { error: agent.error } : {}), ...linkage },
        failed ? "error" : "info",
      );
      return;
    }
    push(
      `${prefix}:completed`,
      settleAt,
      "task.completed",
      failed ? "Task failed" : "Task completed",
      {
        taskId,
        status: failed ? "failed" : "completed",
        ...(outcome ? { summary: outcome, detail: outcome } : {}),
        ...linkage,
      },
      failed ? "error" : "info",
    );
  });
  return rows;
}

function derivedContextTokens(thread: DemoThread): number {
  const toolCount = thread.exchanges.reduce(
    (sum, _exchange, index) => sum + turnTools(thread, index).length,
    0,
  );
  const max = DEMO_CONTEXT_WINDOW_BY_PROVIDER[thread.provider];
  return Math.min(
    Math.round(max * 0.6),
    14_200 + thread.exchanges.length * 8_700 + toolCount * 3_300,
  );
}

function contextPayload(thread: DemoThread, usedTokens: number, maxTokens: number) {
  const outputTokens = Math.round(usedTokens * 0.06);
  const inputTokens = usedTokens - outputTokens;
  return {
    usedTokens,
    maxTokens,
    totalProcessedTokens: Math.round(usedTokens * 2.4),
    inputTokens,
    cachedInputTokens: Math.round(inputTokens * 0.82),
    outputTokens,
    lastUsedTokens: usedTokens,
    ...(thread.provider === "claudeAgent" ? { compactsAutomatically: true } : {}),
  };
}

export function buildThreadActivities(
  thread: DemoThread,
  windows: ReadonlyArray<DemoTurnWindow>,
): ReadonlyArray<DemoActivity> {
  const rows: DemoActivity[] = [];
  const lastIndex = windows.length - 1;
  const at = (window: DemoTurnWindow, fraction: number) =>
    window.startMinutes - (window.startMinutes - window.endMinutes) * fraction;
  const add = (
    turnIndex: number,
    minutesAgo: number,
    id: string,
    activity: Pick<DemoActivity, "tone" | "kind" | "summary" | "payload">,
  ) => rows.push({ id, turnIndex, minutesAgo, ...activity });

  const maxTokens = thread.context?.maxTokens ?? DEMO_CONTEXT_WINDOW_BY_PROVIDER[thread.provider];
  const finalTokens = thread.context?.usedTokens ?? derivedContextTokens(thread);
  const compaction = thread.compaction;

  windows.forEach((window, turnIndex) => {
    const isLast = turnIndex === lastIndex;
    const hasAgents = isLast && (thread.subagents?.length ?? 0) > 0;
    const tools = turnTools(thread, turnIndex);
    const [from, to] = hasAgents ? [0.05, 0.25] : [0.1, 0.85];
    tools.forEach((tool, n) => {
      const fraction = tools.length === 1 ? from : from + ((to - from) * n) / (tools.length - 1);
      const toolCallId = `${thread.provider === "claudeAgent" ? "toolu" : "call"}_${thread.id.slice(5)}_${turnIndex + 1}_${n + 1}`;
      add(
        turnIndex,
        at(window, fraction),
        `${thread.id}-tool-${turnIndex + 1}-${n + 1}`,
        toolActivity(toolCallId, tool),
      );
    });
    if (compaction?.turn === turnIndex) {
      add(turnIndex, at(window, 0.02), `${thread.id}-compaction`, {
        tone: "info",
        kind: "context-compaction",
        summary: `Compacted context ${formatTokens(compaction.beforeTokens)} → ${formatTokens(compaction.afterTokens)} tokens`,
        payload: {
          state: "compacted",
          beforeTokens: compaction.beforeTokens,
          afterTokens: compaction.afterTokens,
        },
      });
    }
    // One context snapshot per turn, growing toward the final reading.
    const [low, high, first, count] =
      compaction === undefined
        ? [0, finalTokens, 0, windows.length]
        : turnIndex < compaction.turn
          ? [0, compaction.beforeTokens, 0, compaction.turn]
          : [
              compaction.afterTokens,
              finalTokens,
              compaction.turn,
              windows.length - compaction.turn,
            ];
    const usedTokens = Math.round(low + ((high - low) * (turnIndex - first + 1)) / count);
    add(turnIndex, at(window, 0.97), `${thread.id}-context-${turnIndex + 1}`, {
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: contextPayload(thread, usedTokens, maxTokens),
    });
  });

  const lastWindow = windows[lastIndex];
  if (!lastWindow) return rows;
  const todos = thread.todos ?? [];
  if (todos.length > 0) {
    const initial = todos.map(([step], index) => ({
      step,
      status: index === 0 ? "inProgress" : "pending",
    }));
    const latest = todos.map(([step, status]) => ({ step, status }));
    add(lastIndex, at(lastWindow, 0.04), `${thread.id}-todos-1`, {
      tone: "info",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      payload: { plan: initial },
    });
    add(lastIndex, at(lastWindow, 0.9), `${thread.id}-todos-2`, {
      tone: "info",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      payload: { plan: latest },
    });
  }
  rows.push(...subagentActivities(thread, lastWindow, lastIndex));
  if (thread.approval) {
    const fileChange = thread.approvalKind === "file-change";
    add(lastIndex, at(lastWindow, 0.98), `${thread.id}-approval`, {
      tone: "approval",
      kind: "approval.requested",
      summary: fileChange ? "File-change approval requested" : "Command approval requested",
      payload: {
        requestId: demoRequestId(thread),
        requestKind: fileChange ? "file-change" : "command",
        requestType: fileChange ? "file_change_approval" : "command_execution_approval",
        detail: thread.approval,
      },
    });
  }
  if (thread.question) {
    add(lastIndex, at(lastWindow, 0.98), `${thread.id}-question`, {
      tone: "info",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId: demoRequestId(thread),
        questions: [
          {
            id: "choice",
            header: thread.question.header,
            question: thread.question.question,
            options: thread.question.options.map((label) => ({ label, description: "" })),
            multiSelect: false,
          },
        ],
      },
    });
  }
  if (thread.error) {
    add(lastIndex, at(lastWindow, 0.99), `${thread.id}-error`, {
      tone: "error",
      kind: "runtime.error",
      summary: "Runtime error",
      payload: { message: thread.error },
    });
  }
  return rows.toSorted((left, right) => right.minutesAgo - left.minutesAgo);
}
