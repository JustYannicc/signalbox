// A JS build entry keeps upstream compiler assumptions outside the typed adapter's project.
import {
  expressionFunctionBody,
  parseRuntimeFunction,
  scriptExpression,
} from "../vendor/nimbus/core/src/_shared/runtime-function-source.ts";
import { analyzeFunction, releaseScopes } from "../vendor/nimbus/core/src/interpreter/scope.ts";
import { ownFunctionExpression } from "../vendor/nimbus/core/src/interpreter/tree.ts";
import { own } from "../vendor/nimbus/core/src/interpreter/parser-realm.ts";
import {
  SyntaxError,
  reflectGet,
  stringOf,
  stringSlice,
} from "../vendor/nimbus/core/src/interpreter/intrinsics.ts";

const realm = {
  SyntaxError,
  scriptOptions: own({ ecmaVersion: "latest", sourceType: "script" }),
  messageOf(error) {
    const message =
      error !== null && (typeof error === "object" || typeof error === "function")
        ? reflectGet(error, "message")
        : undefined;
    return typeof message === "string" ? message : stringOf(error);
  },
};

// Analyze the exact wrapper Nimbus executes so nested arrows and local bindings resolve correctly.
export function hasSyntheticArgumentsReference(source) {
  const expression = scriptExpression(source, realm);
  if (expression === null) return false;
  const body = expressionFunctionBody(
    stringSlice(source, 0, expression.prologueEnd),
    stringSlice(source, expression.start, expression.end),
  );
  const parsed = parseRuntimeFunction("function", [], body, realm);
  const node = ownFunctionExpression(parsed.node);
  const analysis = analyzeFunction(node);
  const root = analysis.functionScopeOf(node);
  try {
    return root.argumentsBinding !== null;
  } finally {
    releaseScopes(root);
  }
}
