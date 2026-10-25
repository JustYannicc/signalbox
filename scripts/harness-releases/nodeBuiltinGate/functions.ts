import ts from "typescript-legacy";
import type { NodeBuiltinAmbiguity, NodeBuiltinFunctionCall } from "./coverage.ts";
import { builtinCallGuard } from "./callGuards.ts";
import {
  isBuiltinReference,
  resolveBuiltinFunctionReferences,
  type BuiltinReference,
  type BuiltinFunctionAnalysisOrigin,
} from "./functionReferences.ts";
import type { RequireBindings } from "../../claude-bunfs/release-inventory-require.ts";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import { unusedRequireFallbacks } from "./unusedRequireFallback.ts";

function withoutFunctionPrototypeOperation(
  reference: BuiltinReference,
):
  | { readonly operation: "call" | "apply" | "bind"; readonly reference: BuiltinReference }
  | undefined {
  if (reference.kind !== "member" && reference.kind !== "dynamic-member") return undefined;
  const operation = reference.memberPath.at(-1);
  if (operation !== "call" && operation !== "apply" && operation !== "bind") return undefined;
  if (reference.memberPath.length < 2) return undefined;
  const memberPath = reference.memberPath.slice(0, -1);
  return { operation, reference: { ...reference, memberPath } };
}

/** Scans direct builtin calls while retaining unresolved computed member calls. */
export function scanBuiltinFunctionCalls(
  file: ts.SourceFile,
  bindings: ScopedBindings<BuiltinFunctionAnalysisOrigin>,
  requires: RequireBindings,
) {
  const { reference } = resolveBuiltinFunctionReferences(file, bindings, requires);
  const functionCalls: NodeBuiltinFunctionCall[] = [];
  const ambiguities: NodeBuiltinAmbiguity[] = [];
  const unusedFallbacks = unusedRequireFallbacks(file, bindings);

  const addAmbiguity = (
    node: ts.Node,
    specifier: string,
    memberPath: readonly string[],
    kind = "dynamic-builtin-member-call",
  ) => {
    const point = file.getLineAndCharacterOfPosition(node.getStart(file));
    ambiguities.push({
      kind,
      module: file.fileName,
      line: point.line + 1,
      column: point.character + 1,
      specifier: `${specifier}.${memberPath.join(".") || "<computed>"}`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (unusedFallbacks.has(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let callee = reference(node.expression);
      const prototypeOperation = callee && withoutFunctionPrototypeOperation(callee);
      if (prototypeOperation?.operation === "call" || prototypeOperation?.operation === "apply")
        callee = prototypeOperation.reference;
      if (
        prototypeOperation?.operation !== "bind" &&
        isBuiltinReference(callee) &&
        (callee.kind === "member" || callee.kind === "module" || callee.kind === "bundled-module")
      ) {
        const guard = prototypeOperation
          ? undefined
          : builtinCallGuard(
              node,
              callee.specifier,
              callee.kind === "member" ? callee.memberPath : [],
            );
        functionCalls.push({
          specifier: callee.specifier,
          memberPath: callee.kind === "member" ? callee.memberPath : [],
          module: file.fileName,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          column: file.getLineAndCharacterOfPosition(node.getStart(file)).character + 1,
          ...(guard === undefined ? {} : { guard }),
        });
      } else if (
        prototypeOperation?.operation !== "bind" &&
        isBuiltinReference(callee) &&
        (callee.kind === "dynamic-member" || callee.kind === "dynamic-module")
      ) {
        addAmbiguity(
          node,
          callee.specifier,
          callee.kind === "dynamic-member" ? callee.memberPath : [],
        );
      } else if (callee?.kind === "dynamic-require") {
        addAmbiguity(node, "require", [], "dynamic-builtin-loader-call");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  functionCalls.sort(
    (left, right) =>
      compare(left.specifier, right.specifier) ||
      compare(left.memberPath.join("."), right.memberPath.join(".")) ||
      compare(left.module, right.module) ||
      left.line - right.line ||
      left.column - right.column,
  );
  ambiguities.sort(
    (left, right) =>
      compare(left.module, right.module) ||
      left.line - right.line ||
      left.column - right.column ||
      compare(left.kind, right.kind),
  );

  return {
    requiredFunctions: functionCalls,
    functionAmbiguities: ambiguities,
    functionCallScope: "static-direct-calls" as const,
  };
}
