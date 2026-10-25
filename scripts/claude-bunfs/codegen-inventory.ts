import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";
import { isNodeRequireCall, nodeRequireBindings } from "./release-inventory-require.ts";

export interface CodegenModule {
  readonly name: string;
  readonly key: string;
  readonly source: string;
  readonly format?: number;
}

export interface CodegenFinding {
  readonly kind:
    | "Function"
    | "eval"
    | "vm"
    | "WebAssembly"
    | "WebAssembly.compile"
    | "WebAssembly.instantiate"
    | "WebAssembly.Module"
    | "WebAssembly.compileStreaming"
    | "WebAssembly.instantiateStreaming"
    | "proc-path";
  readonly operation: string;
  readonly module: string;
  readonly key: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly literal?: string;
}

const vmCodegenMembers = new Set([
  "Script",
  "compileFunction",
  "runInContext",
  "runInNewContext",
  "runInThisContext",
]);
const webAssemblyCodegenMembers = new Set([
  "compile",
  "instantiate",
  "Module",
  "compileStreaming",
  "instantiateStreaming",
]);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lineLocation(file: ts.SourceFile, module: CodegenModule, node: ts.Node) {
  const offset = node.getStart(file);
  const point = file.getLineAndCharacterOfPosition(offset);
  return {
    module: module.name,
    key: module.key,
    line: point.line + 1,
    column: point.character + 1,
    offset,
  };
}

function staticText(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isAwaitExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

function isVmSpecifier(node: ts.Expression | undefined): boolean {
  return Boolean(node && ts.isStringLiteralLike(node) && ["vm", "node:vm"].includes(node.text));
}

function isCallTarget(node: ts.Node): "call" | "construct" | "reference" {
  const parent = node.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === node) return "call";
  if (parent && ts.isNewExpression(parent) && parent.expression === node) return "construct";
  return "reference";
}

function globalMember(
  expression: ts.Expression,
  bindings: ScopedBindings<true>,
): string | undefined {
  if (ts.isIdentifier(expression)) return bindings.lookup(expression) ? undefined : expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis" &&
    !bindings.lookup(expression.expression)
  )
    return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "globalThis" &&
    !bindings.lookup(expression.expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  )
    return expression.argumentExpression.text;
  return undefined;
}

function record(
  file: ts.SourceFile,
  module: CodegenModule,
  findings: CodegenFinding[],
  kind: CodegenFinding["kind"],
  operation: string,
  node: ts.Node,
  literal?: string,
): void {
  findings.push({
    ...lineLocation(file, module, node),
    kind,
    operation,
    ...(literal === undefined ? {} : { literal }),
  });
}

type VmBinding =
  | { readonly kind: "namespace" }
  | { readonly kind: "member"; readonly name: string };
const vmNamespace: VmBinding = { kind: "namespace" };

function vmBindings(
  file: ts.SourceFile,
  requireBindings: ReturnType<typeof nodeRequireBindings>,
): ScopedBindings<VmBinding> {
  const bindings = new ScopedBindings<VmBinding>(file);
  const assignPattern = (pattern: ts.BindingName, binding: VmBinding): void => {
    if (ts.isIdentifier(pattern)) bindings.setOrigin(pattern, binding);
    else if (ts.isObjectBindingPattern(pattern))
      for (const element of pattern.elements) {
        const name =
          element.propertyName &&
          (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
            ? element.propertyName.text
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
        if (name === undefined) continue;
        assignPattern(
          element.name,
          binding.kind === "namespace"
            ? { kind: "member", name }
            : { kind: "member", name: `${binding.name}.${name}` },
        );
      }
  };
  const initialize = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["vm", "node:vm"].includes(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      const clause = node.importClause;
      if (clause.name) bindings.setOrigin(clause.name, vmNamespace);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        bindings.setOrigin(clause.namedBindings.name, vmNamespace);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) {
          bindings.setOrigin(element.name, {
            kind: "member",
            name: element.propertyName?.text ?? element.name.text,
          });
        }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then"
    ) {
      const imported = unwrapExpression(node.expression.expression);
      const callback = node.arguments[0];
      if (
        ts.isCallExpression(imported) &&
        imported.expression.kind === ts.SyntaxKind.ImportKeyword &&
        isVmSpecifier(imported.arguments[0]) &&
        callback &&
        ts.isFunctionLike(callback) &&
        callback.parameters[0]
      )
        assignPattern(callback.parameters[0].name, vmNamespace);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      const loadedVm =
        ts.isCallExpression(initializer) &&
        (initializer.expression.kind === ts.SyntaxKind.ImportKeyword ||
          isNodeRequireCall(initializer, requireBindings)) &&
        isVmSpecifier(initializer.arguments[0]);
      if (loadedVm) assignPattern(node.name, vmNamespace);
    }
    ts.forEachChild(node, initialize);
  };
  initialize(file);

  let declarationCount = 0;
  const countDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarationCount++;
    ts.forEachChild(node, countDeclarations);
  };
  countDeclarations(file);
  for (let pass = 0; pass < declarationCount + 1; pass++) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = node.initializer;
        if (ts.isIdentifier(node.name) && ts.isIdentifier(initializer)) {
          const origin = bindings.lookup(initializer)?.origin;
          if (origin && bindings.lookup(node.name)?.origin !== origin) {
            bindings.setOrigin(node.name, origin);
            changed = true;
          }
        } else if (
          (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) &&
          ts.isIdentifier(initializer)
        ) {
          const origin = bindings.lookup(initializer)?.origin;
          if (origin?.kind === "namespace") assignPattern(node.name, origin);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!changed) break;
  }
  return bindings;
}

function expressionPath(
  expression: ts.Expression,
): { readonly root: ts.Identifier; readonly path: ReadonlyArray<string> } | undefined {
  if (ts.isIdentifier(expression)) return { root: expression, path: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const base = expressionPath(expression.expression);
    return base ? { ...base, path: [...base.path, expression.name.text] } : undefined;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    (ts.isStringLiteralLike(expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
  ) {
    const base = expressionPath(expression.expression);
    return base ? { ...base, path: [...base.path, expression.argumentExpression.text] } : undefined;
  }
  return undefined;
}

function vmMember(
  node: ts.Expression,
  bindings: ScopedBindings<VmBinding>,
  requireBindings: ReturnType<typeof nodeRequireBindings>,
): string | undefined {
  if (ts.isIdentifier(node)) {
    const origin = bindings.lookup(node)?.origin;
    return origin?.kind === "member" ? origin.name : undefined;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const receiver = unwrapExpression(node.expression);
    if (
      ts.isCallExpression(receiver) &&
      (isNodeRequireCall(receiver, requireBindings) ||
        receiver.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      isVmSpecifier(receiver.arguments[0])
    )
      return ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression
          ? staticText(node.argumentExpression)
          : undefined;
  }
  const path = expressionPath(node);
  if (!path) return undefined;
  const origin = bindings.lookup(path.root)?.origin;
  if (!origin) return undefined;
  return origin.kind === "namespace"
    ? path.path.join(".")
    : [...origin.name, ...path.path].join(".");
}

function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    !(
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isPropertyAccessExpression(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.name === node
    ) && !ts.isBindingElement(parent)
  );
}

function isMemberReceiver(node: ts.Expression): boolean {
  return (
    (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
    node.parent.expression === node
  );
}

function functionConstructor(expression: ts.Expression): string | undefined {
  const value = unwrapExpression(expression);
  if (!ts.isFunctionExpression(value) && !ts.isArrowFunction(value)) return undefined;
  const async = value.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  const generator = ts.isFunctionExpression(value) && value.asteriskToken;
  return async
    ? generator
      ? "AsyncGeneratorFunction"
      : "AsyncFunction"
    : generator
      ? "GeneratorFunction"
      : "Function";
}

/** Find executable-code entry points and literal procfs paths in JavaScript modules. */
export function inventoryCodegenFeatures(
  modules: ReadonlyArray<CodegenModule>,
): ReadonlyArray<CodegenFinding> {
  const findings: CodegenFinding[] = [];
  for (const module of [...modules].sort((a, b) => compare(a.key, b.key))) {
    const file = ts.createSourceFile(
      module.name,
      module.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const diagnostics = Reflect.get(file, "parseDiagnostics");
    if (Array.isArray(diagnostics) && diagnostics.length) {
      const diagnostic = diagnostics[0] as ts.Diagnostic;
      const point = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      throw new SyntaxError(
        `${module.name}:${point.line + 1}:${point.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      );
    }
    const globalBindings = new ScopedBindings<true>(file);
    const requireBindings = nodeRequireBindings(file, module.format);
    const vmBindingsByScope = vmBindings(file, requireBindings);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && (node.text === "Function" || node.text === "eval")) {
        const parent = node.parent;
        const declarationName =
          (ts.isVariableDeclaration(parent) && parent.name === node) ||
          (ts.isFunctionDeclaration(parent) && parent.name === node) ||
          (ts.isClassDeclaration(parent) && parent.name === node) ||
          ts.isImportSpecifier(parent) ||
          ts.isParameter(parent);
        const propertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isMethodDeclaration(parent) && parent.name === node);
        if (!declarationName && !propertyName && !globalBindings.lookup(node)) {
          const use = isCallTarget(node);
          record(
            file,
            module,
            findings,
            node.text as "Function" | "eval",
            `${node.text}:${use}`,
            node,
          );
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = globalMember(node, globalBindings);
        if (member === "Function" || member === "eval") {
          const use = isCallTarget(node);
          record(file, module, findings, member, `${member}:${use}`, node);
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        globalMember(node.expression, globalBindings) === "WebAssembly" &&
        webAssemblyCodegenMembers.has(node.name.text)
      ) {
        const kind = `WebAssembly.${node.name.text}` as Extract<
          CodegenFinding["kind"],
          `WebAssembly.${string}`
        >;
        record(file, module, findings, kind, kind, node);
      }
      if (
        ts.isElementAccessExpression(node) &&
        globalMember(node.expression, globalBindings) === "WebAssembly" &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        webAssemblyCodegenMembers.has(node.argumentExpression.text)
      ) {
        const kind = `WebAssembly.${node.argumentExpression.text}` as Extract<
          CodegenFinding["kind"],
          `WebAssembly.${string}`
        >;
        record(file, module, findings, kind, kind, node);
      }
      if (
        (ts.isIdentifier(node) && isValueIdentifier(node)) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        const member = vmMember(node, vmBindingsByScope, requireBindings);
        if (member && vmCodegenMembers.has(member))
          record(file, module, findings, "vm", `vm.${member}`, node);
        if (
          ts.isIdentifier(node) &&
          vmBindingsByScope.lookup(node)?.origin?.kind === "namespace" &&
          !isMemberReceiver(node) &&
          !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)
        )
          record(file, module, findings, "vm", "vm:reference", node);
        if (globalMember(node, globalBindings) === "WebAssembly") {
          const parent = node.parent;
          const member =
            ts.isPropertyAccessExpression(parent) && parent.expression === node
              ? parent.name.text
              : ts.isElementAccessExpression(parent) &&
                  parent.expression === node &&
                  parent.argumentExpression
                ? staticText(parent.argumentExpression)
                : undefined;
          if (!member || !webAssemblyCodegenMembers.has(member))
            record(file, module, findings, "WebAssembly", "WebAssembly:reference", node);
        }
        const constructor = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isElementAccessExpression(node) && node.argumentExpression
            ? staticText(node.argumentExpression)
            : undefined;
        if (
          constructor === "constructor" &&
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        ) {
          const receiver = unwrapExpression(node.expression);
          // General x.constructor.constructor needs runtime value provenance; only literal origins are known here.
          const prototype =
            ts.isCallExpression(receiver) &&
            ts.isPropertyAccessExpression(receiver.expression) &&
            receiver.expression.name.text === "getPrototypeOf" &&
            globalMember(receiver.expression.expression, globalBindings) === "Object" &&
            receiver.arguments[0] &&
            functionConstructor(receiver.arguments[0]);
          const name = prototype || functionConstructor(receiver);
          if (name)
            record(file, module, findings, "Function", `${name}:${isCallTarget(node)}`, node);
        }
      }
      if (
        ts.isCallExpression(node) &&
        (isNodeRequireCall(node, requireBindings) ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
        isVmSpecifier(node.arguments[0])
      ) {
        let outer: ts.Expression = node;
        while (
          outer.parent &&
          (ts.isAwaitExpression(outer.parent) || ts.isParenthesizedExpression(outer.parent)) &&
          outer.parent.expression === outer
        )
          outer = outer.parent;
        const parent = outer.parent;
        const assigned = ts.isVariableDeclaration(parent) && parent.initializer === outer;
        const member =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === outer
            ? vmMember(parent, vmBindingsByScope, requireBindings)
            : undefined;
        const inlineThen =
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === "then" &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent &&
          parent.parent.arguments[0] &&
          ts.isFunctionLike(parent.parent.arguments[0]);
        if (!assigned && !(member && vmCodegenMembers.has(member)) && !inlineThen)
          record(file, module, findings, "vm", "vm:reference", node);
      }
      if (
        ts.isStringLiteralLike(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const text =
          staticText(node) ??
          ("text" in node && typeof node.text === "string" ? node.text : undefined);
        if (text && /\/proc(?:\/|$)/u.test(text))
          record(file, module, findings, "proc-path", "literal contains /proc/", node, text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return findings.sort(
    (a, b) =>
      compare(a.module, b.module) ||
      a.offset - b.offset ||
      compare(a.kind, b.kind) ||
      compare(a.operation, b.operation),
  );
}
