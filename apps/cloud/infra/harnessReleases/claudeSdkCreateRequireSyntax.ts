import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { parse } from "acorn";
import type {
  ClaudeSdkAstNode as AstNode,
  ClaudeSdkParentMap,
} from "./claudeSdkCreateRequireScope.ts";

export interface LocatedNode {
  readonly node: AstNode;
  readonly parent: AstNode | undefined;
}

export interface ClaudeSdkCreateRequireSource {
  readonly nodes: ReadonlyArray<LocatedNode>;
  readonly parentByNode: ClaudeSdkParentMap;
  readonly factoryCalls: ReadonlyArray<AstNode>;
  readonly fileURLToPathFactories: ReadonlySet<string>;
  readonly urlNamespaces: ReadonlySet<string>;
}

export function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "type") === "string" &&
    typeof Reflect.get(value, "start") === "number" &&
    typeof Reflect.get(value, "end") === "number"
  );
}

export function identifier(value: unknown, name?: string): value is AstNode {
  return (
    isAstNode(value) && value.type === "Identifier" && (name === undefined || value.name === name)
  );
}

export function staticString(value: unknown): string | undefined {
  if (!isAstNode(value)) return undefined;
  if (value.type === "Literal") return typeof value.value === "string" ? value.value : undefined;
  if (
    value.type === "TemplateLiteral" &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0 &&
    Array.isArray(value.quasis) &&
    value.quasis.length === 1
  ) {
    const quasi = value.quasis[0];
    if (!isAstNode(quasi) || typeof quasi.value !== "object" || quasi.value === null)
      return undefined;
    const cooked = Reflect.get(quasi.value, "cooked");
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

function collectNodes(root: AstNode): LocatedNode[] {
  const nodes: LocatedNode[] = [];
  const visit = (value: unknown, parent?: AstNode) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
      return;
    }
    if (!isAstNode(value)) return;
    nodes.push({ node: value, parent });
    for (const [key, child] of Object.entries(value))
      if (key !== "start" && key !== "end") visit(child, value);
  };
  visit(root);
  return nodes;
}

function isImportMetaUrl(value: unknown): boolean {
  if (!isAstNode(value) || value.type !== "MemberExpression" || value.computed === true)
    return false;
  const meta = value.object;
  return (
    isAstNode(meta) &&
    meta.type === "MetaProperty" &&
    identifier(meta.meta, "import") &&
    identifier(meta.property, "meta") &&
    identifier(value.property, "url")
  );
}

function isFileURLToPathCall(
  value: unknown,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
) {
  if (!isAstNode(value) || value.type !== "CallExpression" || !Array.isArray(value.arguments))
    return false;
  const callee = value.callee;
  const isFactory =
    (identifier(callee) && factories.has(String(callee.name))) ||
    (isAstNode(callee) &&
      callee.type === "MemberExpression" &&
      callee.computed !== true &&
      identifier(callee.object) &&
      namespaces.has(String(callee.object.name)) &&
      identifier(callee.property, "fileURLToPath"));
  return isFactory && value.arguments.length === 1 && isImportMetaUrl(value.arguments[0]);
}

function validCreateRequireArgument(
  value: unknown,
  fileURLToPathFactories: ReadonlySet<string>,
  urlNamespaces: ReadonlySet<string>,
): boolean {
  if (isImportMetaUrl(value) || identifier(value, "__filename")) return true;
  if (isFileURLToPathCall(value, fileURLToPathFactories, urlNamespaces)) return true;
  const path = staticString(value);
  if (!path) return false;
  if (NodePath.isAbsolute(path)) return true;
  try {
    const url = new URL(path);
    return url.protocol === "file:" && NodePath.isAbsolute(NodeURL.fileURLToPath(url));
  } catch {
    return false;
  }
}

function isModuleRequire(value: unknown): boolean {
  return (
    isAstNode(value) &&
    value.type === "CallExpression" &&
    identifier(value.callee, "require") &&
    Array.isArray(value.arguments) &&
    value.arguments.length === 1 &&
    ["module", "node:module"].includes(staticString(value.arguments[0]) ?? "")
  );
}

function isUrlRequire(value: unknown): boolean {
  return (
    isAstNode(value) &&
    value.type === "CallExpression" &&
    identifier(value.callee, "require") &&
    Array.isArray(value.arguments) &&
    value.arguments.length === 1 &&
    ["url", "node:url"].includes(staticString(value.arguments[0]) ?? "")
  );
}

function bindingsFromRequire(
  declaration: AstNode,
  namespaceNames: Set<string>,
  exportName: string,
  importedNames: Set<string>,
) {
  const id = declaration.id;
  if (identifier(id)) {
    namespaceNames.add(String(id.name));
    return;
  }
  if (!isAstNode(id) || id.type !== "ObjectPattern" || !Array.isArray(id.properties)) return;
  for (const item of id.properties) {
    if (!isAstNode(item) || item.type !== "Property") continue;
    const key = item.computed
      ? staticString(item.key)
      : identifier(item.key)
        ? String(item.key.name)
        : staticString(item.key);
    if (key === exportName && identifier(item.value)) importedNames.add(String(item.value.name));
  }
}

function isFactoryCall(
  node: AstNode,
  factories: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  if (node.type !== "CallExpression" || !isAstNode(node.callee)) return false;
  if (identifier(node.callee) && factories.has(String(node.callee.name))) return true;
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    identifier(callee.object) &&
    namespaces.has(String(callee.object.name)) &&
    identifier(callee.property, "createRequire")
  );
}

export function analyzeClaudeSdkCreateRequireSource(source: string): ClaudeSdkCreateRequireSource {
  let tree: AstNode;
  try {
    tree = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch {
    throw new Error("CLAUDE_SDK_SOURCE_PARSE_FAILED");
  }
  const nodes = collectNodes(tree);
  const parentByNode = new Map(nodes.map(({ node, parent }) => [node, parent]));
  const factories = new Set<string>();
  const namespaces = new Set<string>();
  const fileURLToPathFactories = new Set<string>();
  const urlNamespaces = new Set<string>();

  for (const { node } of nodes) {
    const importSource = node.type === "ImportDeclaration" ? staticString(node.source) : undefined;
    if (!importSource || !Array.isArray(node.specifiers)) continue;
    const moduleImport = ["module", "node:module"].includes(importSource);
    const urlImport = ["url", "node:url"].includes(importSource);
    if (!moduleImport && !urlImport) continue;
    for (const item of node.specifiers) {
      if (!isAstNode(item) || !identifier(item.local)) continue;
      const namespaceNames = moduleImport ? namespaces : urlNamespaces;
      const bindings = moduleImport ? factories : fileURLToPathFactories;
      if (item.type === "ImportDefaultSpecifier" || item.type === "ImportNamespaceSpecifier")
        namespaceNames.add(String(item.local.name));
      if (
        item.type === "ImportSpecifier" &&
        (moduleImport
          ? identifier(item.imported, "createRequire") ||
            staticString(item.imported) === "createRequire"
          : identifier(item.imported, "fileURLToPath") ||
            staticString(item.imported) === "fileURLToPath")
      )
        bindings.add(String(item.local.name));
    }
  }

  for (const { node } of nodes) {
    if (node.type !== "VariableDeclarator" || !isAstNode(node.init)) continue;
    if (isModuleRequire(node.init))
      bindingsFromRequire(node, namespaces, "createRequire", factories);
    if (isUrlRequire(node.init))
      bindingsFromRequire(node, urlNamespaces, "fileURLToPath", fileURLToPathFactories);
  }

  const factoryCalls = nodes
    .map(({ node }) => node)
    .filter((node) => isFactoryCall(node, factories, namespaces));
  return { nodes, parentByNode, factoryCalls, fileURLToPathFactories, urlNamespaces };
}

export function validCreateRequireBase(
  factory: AstNode,
  declaration: AstNode,
  parentByNode: ClaudeSdkParentMap,
  fileURLToPathFactories: ReadonlySet<string>,
  urlNamespaces: ReadonlySet<string>,
) {
  const args = factory.arguments;
  if (!Array.isArray(args) || args.length !== 1) return false;
  if (validCreateRequireArgument(args[0], fileURLToPathFactories, urlNamespaces)) return true;
  if (!identifier(args[0])) return false;
  const statement = parentByNode.get(declaration);
  if (statement?.type !== "VariableDeclaration" || !Array.isArray(statement.declarations))
    return false;
  const factoryIndex = statement.declarations.indexOf(declaration);
  if (factoryIndex !== 1) return false;
  const base = statement.declarations[0];
  return (
    isAstNode(base) &&
    identifier(base.id, String(args[0].name)) &&
    validCreateRequireArgument(base.init, fileURLToPathFactories, urlNamespaces)
  );
}
