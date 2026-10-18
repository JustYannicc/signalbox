import { defineRule, type ESTree } from "@oxlint/plugins";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

// Chromium's scroll methods return promises, which React calls as cleanup on unmount.
const NON_CLEANUP_METHODS = new Set([
  "scrollIntoView",
  "scrollTo",
  "scrollBy",
  "scroll",
  "focus",
  "blur",
  "click",
  "select",
  "play",
  "pause",
  "requestFullscreen",
  "exitFullscreen",
  "showModal",
  "requestPointerLock",
]);

const NON_CLEANUP_BODY_TYPES = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "AwaitExpression",
  "NewExpression",
  "Literal",
  "TemplateLiteral",
  "ObjectExpression",
  "ArrayExpression",
]);

function unwrap(node: ESTree.Node): ESTree.Node {
  switch (node.type) {
    case "ChainExpression":
    case "ParenthesizedExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSTypeAssertion":
      return unwrap(node.expression);
    default:
      return node;
  }
}

function calleeName(node: ESTree.Node): string | undefined {
  const expression = unwrap(node);
  if (expression.type === "Identifier") return expression.name;
  if (expression.type !== "MemberExpression") return;
  if (!expression.computed && expression.property.type === "Identifier") {
    return expression.property.name;
  }
  if (expression.property.type === "Literal" && typeof expression.property.value === "string") {
    return expression.property.value;
  }
}

function leaksNonCleanup(body: ESTree.Node): boolean {
  const expression = unwrap(body);
  if (NON_CLEANUP_BODY_TYPES.has(expression.type)) return true;
  if (expression.type !== "CallExpression") return false;
  const name = calleeName(expression.callee);
  return name !== undefined && NON_CLEANUP_METHODS.has(name);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Prevent React effects from returning a non-cleanup expression." },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !EFFECT_HOOKS.has(name)) return;
        const argument = node.arguments[0];
        if (!argument) return;
        const callback = unwrap(argument);
        if (callback.type !== "ArrowFunctionExpression" || !leaksNonCleanup(callback.body)) return;
        context.report({
          node: callback,
          message: `Wrap the ${name} callback body in braces. React calls its return value on unmount ("destroy is not a function").`,
        });
      },
    };
  },
});
