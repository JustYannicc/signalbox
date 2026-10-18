import { parse } from "acorn";

export const UNDICI_WASM_IMPORTS = Object.freeze({
  simd: "signalbox:node-environment/llhttp-simd.wasm",
  fallback: "signalbox:node-environment/llhttp.wasm",
});

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface LocatedNode {
  readonly node: AstNode;
  readonly parent: AstNode | undefined;
}

interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const SIMD_REQUIRE = "../llhttp/llhttp_simd-wasm.js";
const FALLBACK_REQUIRE = "../llhttp/llhttp-wasm.js";

/** Replace only the pinned undici 8.11.2 llhttp constructors with WorkerLoader wasm imports. */
export function transformUndiciClientH1Source(source: string): string {
  const tree = parse(source, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AstNode;
  const nodes = collectNodes(tree);
  const lazyllhttp = one(
    nodes.filter(
      ({ node }) => node.type === "FunctionDeclaration" && isIdentifier(node.id, "lazyllhttp"),
    ),
    "lazyllhttp function",
  ).node;
  const moduleConstructors = nodes.filter(({ node }) => isWebAssemblyModule(node));
  if (
    moduleConstructors.length !== 2 ||
    moduleConstructors.some(({ node }) => !isWithin(node, lazyllhttp))
  ) {
    throw unsupported("expected exactly two WebAssembly.Module constructors in lazyllhttp");
  }

  const simdConstructor = one(
    moduleConstructors.filter(({ node }) => isStaticRequire(argument(node, 0), SIMD_REQUIRE)),
    "SIMD module constructor",
  ).node;
  const fallbackConstructor = one(
    moduleConstructors.filter(({ node }) => isFallbackConstructor(node)),
    "fallback module constructor",
  ).node;
  if (simdConstructor === fallbackConstructor) {
    throw unsupported("SIMD and fallback module constructors must be distinct");
  }

  const fallbackDeclaration = one(
    nodes.filter(
      ({ node }) => node.type === "VariableDeclarator" && isIdentifier(node.id, "llhttpWasmData"),
    ),
    "llhttpWasmData declaration",
  );
  if (
    !isWithin(fallbackDeclaration.node, lazyllhttp) ||
    !isKnownFallbackDeclaration(fallbackDeclaration.node, fallbackDeclaration.parent)
  ) {
    throw unsupported("llhttpWasmData must keep undici's known process.env fallback shape");
  }

  const dataIdentifiers = nodes.filter(({ node }) => isIdentifier(node, "llhttpWasmData"));
  if (
    dataIdentifiers.length !== 2 ||
    !dataIdentifiers.some(({ node }) => node === fallbackDeclaration.node.id) ||
    !dataIdentifiers.some(
      ({ node, parent }) =>
        isIdentifier(node, "llhttpWasmData") &&
        parent?.type === "LogicalExpression" &&
        parent.operator === "||" &&
        isFallbackConstructorArgument(parent),
    )
  ) {
    throw unsupported("llhttpWasmData must be used only by the known fallback constructor");
  }

  const simdRequires = callsTo(nodes, SIMD_REQUIRE);
  const fallbackRequires = callsTo(nodes, FALLBACK_REQUIRE);
  if (simdRequires.length !== 1 || fallbackRequires.length !== 2) {
    throw unsupported("unexpected llhttp wasm require expressions");
  }

  const declaration = fallbackDeclaration.parent;
  if (
    declaration?.type !== "VariableDeclaration" ||
    !Array.isArray(declaration.declarations) ||
    declaration.declarations.length !== 1
  ) {
    throw unsupported("llhttpWasmData must have its own declaration");
  }

  const edits: SourceEdit[] = [
    { start: simdConstructor.start, end: simdConstructor.end, text: "llhttpWasmSimd" },
    { start: fallbackConstructor.start, end: fallbackConstructor.end, text: "llhttpWasmFallback" },
    { start: declaration.start, end: declaration.end, text: "" },
  ];
  let rewritten = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }

  return [
    `import llhttpWasmSimd from ${JSON.stringify(UNDICI_WASM_IMPORTS.simd)};`,
    `import llhttpWasmFallback from ${JSON.stringify(UNDICI_WASM_IMPORTS.fallback)};`,
    rewritten,
  ].join("\n");
}

function collectNodes(root: AstNode): LocatedNode[] {
  const located: LocatedNode[] = [];
  const visit = (value: unknown, parent?: AstNode) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent);
      return;
    }
    if (!isAstNode(value)) return;
    located.push({ node: value, parent });
    for (const [key, child] of Object.entries(value)) {
      if (key !== "start" && key !== "end") visit(child, value);
    }
  };
  visit(root);
  return located;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "type") === "string" &&
    typeof Reflect.get(value, "start") === "number" &&
    typeof Reflect.get(value, "end") === "number"
  );
}

function one<T>(values: readonly T[], label: string): T {
  if (values.length !== 1) throw unsupported(`expected one ${label}; found ${values.length}`);
  return values[0]!;
}

function isIdentifier(value: unknown, name: string): value is AstNode {
  return isAstNode(value) && value.type === "Identifier" && value.name === name;
}

function isWebAssemblyModule(node: AstNode): boolean {
  const callee = node.callee;
  return (
    node.type === "NewExpression" &&
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.object, "WebAssembly") &&
    isIdentifier(callee.property, "Module")
  );
}

function isStaticRequire(value: unknown, specifier: string): boolean {
  if (
    !isAstNode(value) ||
    value.type !== "CallExpression" ||
    !isIdentifier(value.callee, "require")
  ) {
    return false;
  }
  const args = value.arguments;
  return (
    Array.isArray(args) &&
    args.length === 1 &&
    isAstNode(args[0]) &&
    args[0].type === "Literal" &&
    args[0].value === specifier
  );
}

function isFallbackConstructor(node: AstNode): boolean {
  const expression = argument(node, 0);
  return (
    isAstNode(expression) &&
    expression.type === "LogicalExpression" &&
    expression.operator === "||" &&
    isIdentifier(expression.left, "llhttpWasmData") &&
    isStaticRequire(expression.right, FALLBACK_REQUIRE)
  );
}

function isFallbackConstructorArgument(node: AstNode): boolean {
  return (
    node.type === "LogicalExpression" &&
    node.operator === "||" &&
    isIdentifier(node.left, "llhttpWasmData") &&
    isStaticRequire(node.right, FALLBACK_REQUIRE)
  );
}

function isKnownFallbackDeclaration(node: AstNode, parent: AstNode | undefined): boolean {
  if (
    parent?.type !== "VariableDeclaration" ||
    parent.kind !== "const" ||
    !Array.isArray(parent.declarations) ||
    parent.declarations.length !== 1 ||
    !isAstNode(node.init) ||
    node.init.type !== "ConditionalExpression" ||
    !isProcessJestWorkerTest(node.init.test) ||
    !isStaticRequire(node.init.consequent, FALLBACK_REQUIRE) ||
    !isIdentifier(node.init.alternate, "undefined")
  ) {
    return false;
  }
  return true;
}

function isProcessJestWorkerTest(value: unknown): boolean {
  if (!isAstNode(value) || value.type !== "MemberExpression" || value.computed !== false)
    return false;
  const environment = value.object;
  return (
    isIdentifier(value.property, "JEST_WORKER_ID") &&
    isAstNode(environment) &&
    environment.type === "MemberExpression" &&
    environment.computed === false &&
    isIdentifier(environment.object, "process") &&
    isIdentifier(environment.property, "env")
  );
}

function argument(node: AstNode, index: number): unknown {
  if (node.type !== "NewExpression" || !Array.isArray(node.arguments)) return undefined;
  return node.arguments.length === 1 ? node.arguments[index] : undefined;
}

function callsTo(nodes: readonly LocatedNode[], specifier: string): LocatedNode[] {
  return nodes.filter(({ node }) => isStaticRequire(node, specifier));
}

function isWithin(node: AstNode, ancestor: AstNode): boolean {
  return node.start >= ancestor.start && node.end <= ancestor.end;
}

function unsupported(detail: string): Error {
  return new Error(`[node-environment] unsupported undici llhttp source: ${detail}`);
}
