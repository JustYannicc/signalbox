import type { Node } from "oxc-parser";

import { unwrap } from "./literals.ts";

const TIME_HINT = "Use trigger.at (when the run started, an ISO string) or a time a step returned.";
const RANDOM_HINT =
  "Draw it inside a function passed to w.run, or derive it from the input or a step's result.";

/** Global calls whose result changes between replays, by `object.method` (or bare name). */
const CHANGING_CALLS = new Map([
  ["Date.now", TIME_HINT],
  ["performance.now", TIME_HINT],
  ["Date", TIME_HINT],
  ["Math.random", RANDOM_HINT],
  ["crypto.randomUUID", RANDOM_HINT],
  ["crypto.getRandomValues", RANDOM_HINT],
]);

/** `Date`, or `Math.random` for a non-computed member call on a global. */
function calleeName(callee: Node): { name: string; global: string } | null {
  const node = unwrap(callee);
  if (node.type === "Identifier") return { name: node.name, global: node.name };
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.property.type === "Identifier"
  ) {
    return { name: `${node.object.name}.${node.property.name}`, global: node.object.name };
  }
  return null;
}

/**
 * Why a call or `new` gives a different value each time workflow code
 * replays, or null when it doesn't. Workflow code outside steps re-runs on
 * every wake, possibly in an isolate other runs share, so it has to compute
 * the same thing every time. `declared` holds the file's own names, so a local
 * `Date` isn't mistaken for the global.
 */
export function changingCall(
  node: Node,
  declared: ReadonlySet<string>,
): { message: string; hint: string } | null {
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return null;
  const callee = calleeName(node.callee);
  if (!callee || declared.has(callee.global)) return null;
  // `new Date(x)` and `Date.parse(x)` are fine; only the current time changes.
  if (node.type === "NewExpression") {
    if (callee.name !== "Date" || node.arguments.length > 0) return null;
    return { message: "new Date() changes every time the code replays.", hint: TIME_HINT };
  }
  const hint = CHANGING_CALLS.get(callee.name);
  if (!hint) return null;
  return { message: `${callee.name}() changes every time the code replays.`, hint };
}
