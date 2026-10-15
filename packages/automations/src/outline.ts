import type { AutomationStep, WorkflowArm, WorkflowGraph, WorkflowNode } from "@t3tools/contracts";
import { workflowNodeIdForStepKey } from "@t3tools/contracts";

/**
 * The diagram as indented text, top to bottom, for agents and logs. With
 * `steps`, each step node shows how its latest run of it went.
 */
export function outlineGraph(
  graph: WorkflowGraph,
  steps: ReadonlyArray<AutomationStep> = [],
): string {
  const statusByNode = new Map<string, string>();
  for (const step of steps) {
    const nodeId = workflowNodeIdForStepKey(step.key);
    const previous = statusByNode.get(nodeId);
    statusByNode.set(
      nodeId,
      previous && previous !== step.status ? `${previous}, ${step.status}` : step.status,
    );
  }
  const lines: string[] = [];
  const arms = (list: ReadonlyArray<WorkflowArm>, depth: number) => {
    for (const arm of list) {
      lines.push(`${"  ".repeat(depth)}[${arm.label || "otherwise"}]`);
      walk(arm.body, depth + 1);
    }
  };
  const walk = (nodes: ReadonlyArray<WorkflowNode>, depth: number) => {
    const pad = "  ".repeat(depth);
    for (const node of nodes) {
      switch (node.type) {
        case "step": {
          const service = node.service ? ` (${node.service})` : "";
          const status = statusByNode.get(node.id);
          lines.push(
            `${pad}${node.verb}${service}: ${node.label.text}${status ? ` — ${status}` : ""}`,
          );
          break;
        }
        case "branch":
          lines.push(`${pad}decide: ${node.label.text}`);
          arms(node.arms, depth + 1);
          break;
        case "loop":
          lines.push(
            `${pad}${node.verb}: ${node.label.text}${node.max ? ` (max ${node.max})` : ""}`,
          );
          walk(node.body, depth + 1);
          break;
        case "parallel":
          lines.push(`${pad}at the same time: ${node.label.text}`);
          arms(node.branches, depth + 1);
          break;
        case "try":
          lines.push(`${pad}try: ${node.label.text}`);
          walk(node.body, depth + 1);
          lines.push(`${pad}  [if it fails]`);
          walk(node.failure, depth + 2);
          break;
        case "end":
          lines.push(`${pad}${node.done ? "done" : "stop"}`);
          break;
      }
    }
  };
  walk(graph.nodes, 0);
  return lines.join("\n");
}
