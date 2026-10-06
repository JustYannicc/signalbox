import type { WorkflowLabel } from "@t3tools/contracts";
import type { Node } from "oxc-parser";

import type { WorkflowSource } from "./source.ts";

/** The arm a decision takes when none of its options match. */
export const OTHERWISE = "Otherwise";

/** A label read straight from the code, for decisions without a comment above them. */
export function plainLabel(source: WorkflowSource, node: Node): WorkflowLabel {
  return { text: source.summary(node), dynamic: false };
}

type LoopStatement = Extract<
  Node,
  {
    type:
      | "ForStatement"
      | "ForInStatement"
      | "ForOfStatement"
      | "WhileStatement"
      | "DoWhileStatement";
  }
>;

/** "For each issue in found.issues", "While page.next": a plain loop's label when it has no comment. */
export function loopLabel(source: WorkflowSource, loop: LoopStatement): string {
  switch (loop.type) {
    case "ForOfStatement":
    case "ForInStatement": {
      const left =
        loop.left.type === "VariableDeclaration" ? loop.left.declarations[0]?.id : loop.left;
      const item = left ? source.summary(left) : "item";
      return `For each ${loop.type === "ForInStatement" ? "key" : item} in ${source.summary(loop.right)}`;
    }
    case "WhileStatement":
    case "DoWhileStatement":
      return `While ${source.summary(loop.test)}`;
    case "ForStatement":
      return loop.test ? `While ${source.summary(loop.test)}` : "Loop";
  }
}
