import { defineRule } from "@oxlint/plugins";

// React treats whatever an effect callback returns as its cleanup and calls it
// on unmount. An expression-bodied arrow leaks the expression's value there.
// Chromium's scroll methods now return promises, so
// `useLayoutEffect(() => el?.scrollIntoView())` crashes on unmount with
// "destroy is not a function". Calls that return an unsubscribe function
// (`() => store.subscribe(fn)`) are the intended use and stay allowed.
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

// DOM methods whose results are never a cleanup function.
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

// Expression bodies whose value is never a cleanup function.
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

interface Node {
  readonly type: string;
  readonly name?: string;
  readonly expression?: Node;
  readonly callee?: Node;
  readonly property?: Node;
}

function calleeName(callee: Node | undefined) {
  if (!callee) return undefined;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return callee.property.name;
  }
  return undefined;
}

function leaksNonCleanup(body: Node): boolean {
  const expression = body.type === "ChainExpression" && body.expression ? body.expression : body;
  if (NON_CLEANUP_BODY_TYPES.has(expression.type)) return true;
  if (expression.type === "CallExpression") {
    const name = calleeName(expression.callee);
    return name !== undefined && NON_CLEANUP_METHODS.has(name);
  }
  return false;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow effect callbacks whose expression body returns a non-function; React calls it as the cleanup.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (!name || !EFFECT_HOOKS.has(name)) return;
        const callback = node.arguments[0];
        if (!callback || callback.type !== "ArrowFunctionExpression") return;
        if (callback.body.type === "BlockStatement") return;
        if (!leaksNonCleanup(callback.body)) return;
        context.report({
          node: callback,
          message: `Wrap the ${name} callback body in braces. Its value becomes the effect cleanup, which React calls on unmount ("destroy is not a function").`,
        });
      },
    };
  },
});
