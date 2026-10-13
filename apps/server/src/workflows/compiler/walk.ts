import { visitorKeys, type Node } from "oxc-parser";

/** Keys that hold types, decorators or labels: never values the workflow computes. */
const SKIPPED_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeArguments",
  "decorators",
  "label",
  "implements",
]);

const VALUE_TS_NODES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);

export function isFunctionNode(node: Node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Keys holding names rather than references: bindings, and non-computed property names. */
function isNameKey(node: Node, key: string) {
  switch (node.type) {
    case "MemberExpression":
      return key === "property" && !node.computed;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
    case "AccessorProperty":
      return key === "key" && !node.computed;
    case "VariableDeclarator":
    case "ClassDeclaration":
    case "ClassExpression":
      return key === "id";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return key === "id" || key === "params";
    case "CatchClause":
      return key === "param";
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return true;
    default:
      return false;
  }
}

/**
 * The children of a node that hold values, in source order. Type-only
 * TypeScript, bindings and property names are skipped, so every
 * `Identifier` reached is a reference.
 */
export function* children(node: Node): Generator<Node> {
  if (node.type.startsWith("TS") && !VALUE_TS_NODES.has(node.type)) return;
  const record = node as unknown as Record<string, unknown>;
  for (const key of visitorKeys[node.type] ?? []) {
    if (SKIPPED_KEYS.has(key) || isNameKey(node, key)) continue;
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object") yield item as Node;
    } else if (value && typeof value === "object") {
      yield value as Node;
    }
  }
}

/**
 * True when `predicate` matches `node` or a descendant. Nested functions are
 * only searched when `intoFunctions` is set.
 */
export function someNode(
  node: Node | null | undefined,
  predicate: (node: Node) => boolean,
  intoFunctions = false,
): boolean {
  if (!node) return false;
  if (predicate(node)) return true;
  for (const child of children(node)) {
    if (!intoFunctions && isFunctionNode(child)) continue;
    if (someNode(child, predicate, intoFunctions)) return true;
  }
  return false;
}

/** Names the file declares itself, so a local `process` isn't mistaken for the global. */
export function declaredNames(program: Node) {
  const names = new Set<string>();
  const add = (node: Node | null | undefined) => {
    if (node?.type === "Identifier") names.add(node.name);
  };
  someNode(
    program,
    (node) => {
      if (node.type === "VariableDeclarator") add(node.id);
      else if (isFunctionNode(node) && "params" in node) {
        if ("id" in node) add(node.id);
        for (const param of node.params)
          add(param.type === "AssignmentPattern" ? param.left : param);
      } else if (node.type === "CatchClause") add(node.param);
      else if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier")
        add(node.local);
      return false;
    },
    true,
  );
  return names;
}
