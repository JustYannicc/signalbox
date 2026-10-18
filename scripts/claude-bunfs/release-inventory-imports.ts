import ts from "typescript-legacy";
import { traceReleaseReachability } from "./release-inventory-graph.ts";
import type { UnresolvedReference } from "./release-inventory-graph.ts";
import {
  resolveNamespaceBindings,
  scanNamespaceMemberUses,
  type BindingOrigin,
} from "./release-inventory-bindings.ts";
import { isNodeRequireCall, nodeRequireBindings } from "./release-inventory-require.ts";

export type { UnresolvedReference } from "./release-inventory-graph.ts";

export interface ScannableModule {
  readonly index: number;
  readonly key: string;
  readonly name: string;
  readonly loader: number;
  readonly format?: number;
  readonly bytes: number;
  readonly source?: string;
}

export interface SourceLocation {
  readonly module: string;
  readonly key: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export type BuiltinImportKind = "named" | "default" | "namespace" | "side-effect" | "require";

export interface BuiltinImport extends SourceLocation {
  readonly kind: BuiltinImportKind;
  readonly imported: string;
  readonly local: string | null;
}

export interface BuiltinMemberUse extends SourceLocation {
  readonly member: string;
  readonly access: "read" | "call" | "construct";
  readonly via: "namespace" | "default" | "require";
  readonly guarded: boolean;
}

export interface BuiltinDynamicMember extends SourceLocation {
  readonly via: "namespace" | "default" | "require";
  readonly guarded: boolean;
}

export interface BuiltinUse {
  readonly specifier: string;
  readonly canonicalBuiltin: string;
  readonly module: string;
  readonly key: string;
  readonly imports: ReadonlyArray<BuiltinImport>;
  readonly memberUses: ReadonlyArray<BuiltinMemberUse>;
  readonly dynamicMemberUses: ReadonlyArray<BuiltinDynamicMember>;
}

export interface ImportInventory {
  readonly builtins: ReadonlyArray<BuiltinUse>;
  readonly reachableIndexes: ReadonlySet<number>;
  readonly unresolvedReferences: ReadonlyArray<UnresolvedReference>;
  readonly unresolvedBareReferences: ReadonlyArray<UnresolvedReference>;
}

const coreBuiltins = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "sqlite",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
  "test",
  "test/reporters",
]);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function position(file: ts.SourceFile, module: ScannableModule, node: ts.Node): SourceLocation {
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

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node)
  )
    node = node.expression;
  return node;
}

function enclosingVariableInitializer(node: ts.Expression): ts.VariableDeclaration | undefined {
  let expression = node;
  while (
    expression.parent &&
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isAwaitExpression(expression.parent)) &&
    expression.parent.expression === expression
  )
    expression = expression.parent;
  return ts.isVariableDeclaration(expression.parent) && expression.parent.initializer === expression
    ? expression.parent
    : undefined;
}

function staticPropertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return node.text;
  return ts.isComputedPropertyName(node) ? stringValue(node.expression) : undefined;
}

function parse(module: ScannableModule): ts.SourceFile {
  if (module.loader !== 1 || typeof module.source !== "string")
    throw new Error(`Expected decoded loader-1 module: ${module.name}`);
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
  return file;
}

function isBuiltin(specifier: string, additional: ReadonlyArray<string>): string | undefined {
  const explicitNodeBuiltin = specifier.startsWith("node:");
  const canonical = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const root = canonical.split("/")[0]!;
  return explicitNodeBuiltin ||
    coreBuiltins.has(canonical) ||
    coreBuiltins.has(root) ||
    additional.includes(canonical) ||
    additional.includes(root)
    ? canonical
    : undefined;
}

function importBindings(
  file: ts.SourceFile,
  module: ScannableModule,
  specifier: string,
  requireBindings: ReturnType<typeof nodeRequireBindings>,
): {
  bindings: BuiltinImport[];
  namespaceNames: Set<string>;
  defaultNames: Set<string>;
  requireNames: Set<string>;
} {
  const bindings: BuiltinImport[] = [];
  const namespaceNames = new Set<string>();
  const defaultNames = new Set<string>();
  const requireNames = new Set<string>();
  const imports: { specifier: string; clause?: ts.ImportClause; node: ts.Node }[] = [];
  const add = (kind: BuiltinImportKind, imported: string, local: string | null, node: ts.Node) => {
    bindings.push({ ...position(file, module, node), kind, imported, local });
  };
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === specifier
    ) {
      imports.push({
        specifier,
        ...(statement.importClause ? { clause: statement.importClause } : {}),
        node: statement.moduleSpecifier,
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === specifier
    ) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements)
          add(
            "named",
            element.propertyName?.text ?? element.name.text,
            element.name.text,
            element.name,
          );
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause))
        add("namespace", "*", statement.exportClause.name.text, statement.exportClause.name);
      else if (!statement.exportClause) add("namespace", "*", null, statement.moduleSpecifier);
    }
  }
  for (const entry of imports) {
    const clause = entry.clause;
    if (!clause) add("side-effect", "*", null, entry.node);
    else if (!clause.isTypeOnly) {
      if (clause.name) {
        defaultNames.add(clause.name.text);
        add("default", "default", clause.name.text, clause.name);
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaceNames.add(clause.namedBindings.name.text);
        add("namespace", "*", clause.namedBindings.name.text, clause.namedBindings.name);
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements)
          if (!element.isTypeOnly)
            add(
              "named",
              element.propertyName?.text ?? element.name.text,
              element.name.text,
              element.name,
            );
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = unwrapExpression(node.initializer);
      const isRequire = ts.isCallExpression(call) && isNodeRequireCall(call, requireBindings);
      const isMetaRequire =
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "require" &&
        ts.isMetaProperty(call.expression.expression);
      if ((isRequire || isMetaRequire) && stringValue(call.arguments[0]) === specifier) {
        if (ts.isIdentifier(node.name)) {
          requireNames.add(node.name.text);
          add("require", "*", node.name.text, node.name);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = element.dotDotDotToken
              ? "*"
              : element.propertyName
                ? (staticPropertyName(element.propertyName) ?? "*")
                : ts.isIdentifier(element.name)
                  ? element.name.text
                  : "*";
            add(
              "require",
              imported,
              ts.isIdentifier(element.name) ? element.name.text : null,
              element.propertyName ?? element.name,
            );
          }
        } else add("require", "*", null, call.arguments[0]!);
      }
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const specifierMatches = stringValue(node.arguments[0]) === specifier;
      if (isDynamicImport && specifierMatches) {
        const declaration = enclosingVariableInitializer(node);
        const local =
          declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
        if (local) namespaceNames.add(local);
        add("namespace", "*", local, node.arguments[0] ?? node);
      }
      const isRequire = isNodeRequireCall(node, requireBindings);
      const isMetaRequire =
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "require" &&
        ts.isMetaProperty(node.expression.expression);
      if ((isRequire || isMetaRequire) && specifierMatches) {
        const isAssigned = enclosingVariableInitializer(node) !== undefined;
        if (!isAssigned) add("require", "*", null, node.arguments[0]!);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { bindings, namespaceNames, defaultNames, requireNames };
}

export function inventoryReleaseImports(
  modules: ReadonlyArray<ScannableModule>,
  entryIndex: number,
  additionalBuiltinNames: ReadonlyArray<string> = [],
): ImportInventory {
  const ordered = [...modules].sort((a, b) => a.index - b.index);
  const reachability = traceReleaseReachability(ordered, entryIndex, [
    ...coreBuiltins,
    ...additionalBuiltinNames,
  ]);
  const sources = ordered
    .filter((module) => module.loader === 1 && reachability.indexes.has(module.index))
    .map((module) => ({ module, file: parse(module) }));
  const builtinMap = new Map<string, BuiltinUse>();
  for (const { module, file } of sources) {
    const requireBindings = nodeRequireBindings(file, module.format);
    const specifiers = new Set<string>();
    for (const statement of file.statements) {
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
        specifiers.add(statement.moduleSpecifier.text);
    }
    const calls = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isNodeRequireCall(node, requireBindings)) {
        const specifier = stringValue(node.arguments[0]);
        if (specifier !== undefined) specifiers.add(specifier);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = stringValue(node.arguments[0]);
        if (specifier !== undefined) specifiers.add(specifier);
      }
      ts.forEachChild(node, calls);
    };
    calls(file);
    for (const specifier of specifiers) {
      const canonical = isBuiltin(specifier, additionalBuiltinNames);
      if (!canonical) continue;
      const found = importBindings(file, module, specifier, requireBindings);
      const initial = new Map<string, BindingOrigin>();
      for (const name of found.namespaceNames) initial.set(name, { via: "namespace", base: [] });
      for (const name of found.defaultNames) initial.set(name, { via: "default", base: [] });
      for (const name of found.requireNames) initial.set(name, { via: "require", base: [] });
      const resolved = resolveNamespaceBindings(file, module, specifier, initial, requireBindings);
      const namespace = scanNamespaceMemberUses(
        file,
        module,
        resolved.bindings,
        specifier,
        requireBindings,
      );
      const imports = found.bindings.sort((a, b) => a.offset - b.offset || compare(a.kind, b.kind));
      const memberUses = [...resolved.destructured, ...namespace.members].sort(
        (a, b) => a.offset - b.offset || compare(a.member, b.member),
      );
      const dynamicMemberUses = [...resolved.dynamic, ...namespace.dynamic]
        .filter(
          (use, index, all) => all.findIndex((other) => other.offset === use.offset) === index,
        )
        .sort((a, b) => a.offset - b.offset);
      builtinMap.set(`${module.index}\0${specifier}`, {
        specifier,
        canonicalBuiltin: canonical,
        module: module.name,
        key: module.key,
        imports,
        memberUses,
        dynamicMemberUses,
      });
    }
  }

  return {
    builtins: [...builtinMap.values()].sort(
      (a, b) =>
        compare(a.canonicalBuiltin, b.canonicalBuiltin) ||
        compare(a.specifier, b.specifier) ||
        compare(a.module, b.module),
    ),
    reachableIndexes: reachability.indexes,
    unresolvedReferences: reachability.unresolvedReferences,
    unresolvedBareReferences: reachability.unresolvedBareReferences,
  };
}
