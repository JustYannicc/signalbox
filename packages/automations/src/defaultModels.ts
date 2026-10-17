import type { WorkflowNode } from "@t3tools/contracts";

/** Whether a workflow step inherits the automation's model selection. */
export const needsDefaultModel = (nodes: ReadonlyArray<WorkflowNode>): boolean =>
  nodes.some((node) => {
    switch (node.type) {
      case "step":
        return (
          (node.verb === "agent" ||
            node.verb === "llm" ||
            node.verb === "judge" ||
            node.verb === "extract") &&
          (node.detail.provider === undefined || node.detail.model === undefined)
        );
      case "branch":
        return node.arms.some((arm) => needsDefaultModel(arm.body));
      case "loop":
        return needsDefaultModel(node.body);
      case "parallel":
        return node.branches.some((branch) => needsDefaultModel(branch.body));
      case "try":
        return needsDefaultModel(node.body) || needsDefaultModel(node.failure);
      case "end":
        return false;
    }
  });
