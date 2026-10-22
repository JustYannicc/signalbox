import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import ts from "typescript-legacy";
import {
  isNodeRequireCall,
  nodeRequireBindings,
  unwrapRequireExpression as unwrap,
} from "../../claude-bunfs/release-inventory-require.ts";
import { ScopedBindings } from "../../claude-bunfs/release-inventory-scope.ts";
import type { NodeBuiltinAmbiguity } from "./coverage.ts";
import { scanBuiltinFunctionCalls } from "./functions.ts";
import {
  builtinMemberReference,
  isBuiltinReference,
  type BuiltinFunctionAnalysisOrigin,
} from "./functionReferences.ts";

const moduleLoaders = [
  { specifier: "module", origin: "module", member: "createRequire", memberOrigin: "factory" },
  {
    specifier: "process",
    origin: "process",
    member: "getBuiltinModule",
    memberOrigin: "builtin-loader",
  },
] as const;
type Origin = BuiltinFunctionAnalysisOrigin;
const moduleForSpecifier = (specifier: string | undefined) =>
  moduleLoaders.find((rule) => rule.specifier === specifier?.replace(/^node:/, ""));
function moduleMember(value: Origin | undefined, name: string | undefined): Origin | undefined {
  if (isBuiltinReference(value)) return builtinMemberReference(value, name);
  const rule = moduleLoaders.find((rule) => rule.origin === value);
  return (
    rule &&
    (name === "default" ? rule.origin : name === rule.member ? rule.memberOrigin : undefined)
  );
}
export interface BuiltinSource {
  readonly name: string;
  readonly source: string;
  readonly format?: number;
}
const literal = (node: ts.Node | undefined) =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined;
function member(node: ts.Expression) {
  node = unwrap(node);
  if (ts.isPropertyAccessExpression(node)) return { target: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node))
    return { target: node.expression, name: literal(node.argumentExpression) };
  return undefined;
}

/** Scan every packaged JS file, including builtin facades already folded into a bundle. */
export function scanBuiltinSource(input: BuiltinSource) {
  const file = ts.createSourceFile(input.name, input.source, ts.ScriptTarget.Latest, true);
  const diagnostics: unknown = Reflect.get(file, "parseDiagnostics");
  if (Array.isArray(diagnostics) && diagnostics.length)
    throw new Error(`NODE_BUILTIN_SOURCE_INVALID: ${input.name}`);
  const bindings = new ScopedBindings<Origin>(file);
  const requires = nodeRequireBindings(file, input.format);
  const references = new Set<string>();
  const ambiguities: NodeBuiltinAmbiguity[] = [];
  const globalName = (node: ts.Expression, name: string) =>
    ts.isIdentifier(node) && node.text === name && !bindings.lookup(node);
  const origin = (raw: ts.Expression): Origin | undefined => {
    const node = unwrap(raw);
    if (ts.isIdentifier(node)) {
      const binding = bindings.lookup(node);
      if (binding?.origin) return binding.origin;
      const required = requires.lookup(node);
      if (required ? required.origin : node.text === "require") return "require";
      return !binding && node.text === "process" ? "process" : undefined;
    }
    const property = member(node);
    if (
      property &&
      (property.name === "default" || moduleLoaders.some((rule) => rule.member === property.name))
    ) {
      const providedMember = moduleMember(origin(property.target), property.name);
      if (providedMember) return providedMember;
    }
    if (property?.name === "require" && origin(property.target) === "bridge") return "require";
    if (
      property?.name === "process" &&
      (globalName(property.target, "globalThis") || globalName(property.target, "global"))
    )
      return "process";
    if (
      property?.name === "require" &&
      (globalName(property.target, "globalThis") || globalName(property.target, "global"))
    )
      return "require";
    if (ts.isElementAccessExpression(node) && globalName(node.expression, "globalThis")) {
      const key = node.argumentExpression;
      if (
        key &&
        ts.isCallExpression(key) &&
        literal(key.arguments[0]) === "signalbox.nodeBridge.v1"
      ) {
        const symbolFor = member(key.expression);
        if (symbolFor?.name === "for" && globalName(symbolFor.target, "Symbol")) return "bridge";
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = origin(node.expression);
      if (callee === "factory") return "require";
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isNodeRequireCall(node, requires) ||
        callee === "require" ||
        callee === "builtin-loader"
      )
        return moduleForSpecifier(literal(node.arguments[0]))?.origin;
    }
    return undefined;
  };
  let changed = false;
  const assign = (name: ts.BindingName, value: Origin | undefined): void => {
    if (!value) return;
    if (ts.isIdentifier(name)) {
      if (bindings.lookup(name)?.origin !== value) {
        bindings.setOrigin(name, value);
        changed = true;
      }
    } else if (ts.isObjectBindingPattern(name)) {
      for (const item of name.elements) {
        if (item.dotDotDotToken) continue;
        const key = item.propertyName ?? item.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
          assign(item.name, moduleMember(value, key.text));
      }
    }
  };
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const rule = moduleForSpecifier(literal(statement.moduleSpecifier));
    const clause = statement.importClause;
    if (!rule || !clause) continue;
    if (clause.name) assign(clause.name, rule.origin);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
      assign(clause.namedBindings.name, rule.origin);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const item of clause.namedBindings.elements)
        assign(item.name, moduleMember(rule.origin, (item.propertyName ?? item.name).text));
  }
  const declarations: ts.VariableDeclaration[] = [];
  const callbacks: { readonly parameter: ts.BindingName; readonly receiver: ts.CallExpression }[] =
    [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    if (ts.isCallExpression(node)) {
      const property = member(node.expression);
      const receiver = property && unwrap(property.target);
      const callback = node.arguments[0];
      if (
        property?.name === "then" &&
        receiver &&
        ts.isCallExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ImportKeyword &&
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        callback.parameters[0]
      ) {
        callbacks.push({ parameter: callback.parameters[0].name, receiver });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  for (let pass = 0; pass <= declarations.length + callbacks.length; pass++) {
    changed = false;
    for (const callback of callbacks) assign(callback.parameter, origin(callback.receiver));
    for (const declaration of declarations)
      if (declaration.initializer) assign(declaration.name, origin(declaration.initializer));
    if (!changed) break;
  }
  const add = (node: ts.Node, argument: ts.Expression | undefined, kind: string) => {
    const specifier = literal(argument);
    if (specifier !== undefined) {
      if (
        kind === "builtin-module" ||
        specifier.startsWith("node:") ||
        NodeModule.isBuiltin(specifier)
      )
        references.add(specifier);
    } else {
      const point = file.getLineAndCharacterOfPosition(node.getStart(file));
      ambiguities.push({
        kind,
        module: input.name,
        line: point.line + 1,
        column: point.character + 1,
        specifier: argument?.getText(file).slice(0, 160) ?? "<missing>",
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node, node.moduleSpecifier as ts.Expression, "static-import");
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, node.arguments[0], "dynamic-import");
      else if (origin(node.expression) === "builtin-loader")
        add(node, node.arguments[0], "builtin-module");
      else if (isNodeRequireCall(node, requires) || origin(node.expression) === "require")
        add(node, node.arguments[0], "dynamic-require");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const functionInventory = scanBuiltinFunctionCalls(file, bindings, requires);
  return {
    name: input.name,
    bytes: Buffer.byteLength(input.source),
    sha256: NodeCrypto.createHash("sha256").update(input.source).digest("hex"),
    requiredSpecifiers: [...references].sort(),
    ambiguities,
    ...functionInventory,
  };
}
