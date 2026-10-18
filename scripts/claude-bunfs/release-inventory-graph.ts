import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";
import type { ScannableModule } from "./release-inventory-imports.ts";
import {
  factoryRequireEscapes,
  isNodeRequireCall,
  nodeRequireBindings,
  nodeRequireEscapes,
} from "./release-inventory-require.ts";

export interface ModuleReference {
  readonly module: string;
  readonly key: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly kind:
    | "static-import"
    | "dynamic-import"
    | "require"
    | "require-escape"
    | "napi-reference"
    | "native-load";
  readonly specifier: string;
  readonly literal: boolean;
}

export interface UnresolvedReference {
  readonly module: string;
  readonly key: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly kind:
    | "dynamic-import"
    | "dynamic-require"
    | "dynamic-native-load"
    | "internal-module"
    | "bare-module";
  readonly specifier: string;
}

export interface Reachability {
  readonly indexes: ReadonlySet<number>;
  readonly unresolvedReferences: ReadonlyArray<UnresolvedReference>;
  readonly unresolvedBareReferences: ReadonlyArray<UnresolvedReference>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

function literal(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function location(file: ts.SourceFile, module: ScannableModule, node: ts.Node) {
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

function nativeLoaderBindings(file: ts.SourceFile) {
  const bindings = new ScopedBindings<"process" | "dlopen">(file);
  const origin = (value: ts.Expression): "process" | "dlopen" | undefined => {
    if (ts.isIdentifier(value))
      return (
        bindings.lookup(value)?.origin ??
        (value.text === "process" && !bindings.lookup(value) ? "process" : undefined)
      );
    if (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === "globalThis" &&
      !bindings.lookup(value.expression) &&
      (ts.isPropertyAccessExpression(value)
        ? value.name.text
        : literal(value.argumentExpression)) === "process"
    )
      return "process";
    if (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "dlopen" &&
      origin(value.expression) === "process"
    )
      return "dlopen";
    if (
      ts.isElementAccessExpression(value) &&
      value.argumentExpression &&
      literal(value.argumentExpression) === "dlopen" &&
      origin(value.expression) === "process"
    )
      return "dlopen";
    return undefined;
  };
  let count = 0;
  const countDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) count++;
    ts.forEachChild(node, countDeclarations);
  };
  countDeclarations(file);
  for (let pass = 0; pass <= count; pass++) {
    let changed = false;
    const assign = (name: ts.Identifier, value: "process" | "dlopen") => {
      if (bindings.lookup(name)?.origin !== value) {
        bindings.setOrigin(name, value);
        changed = true;
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const value = origin(node.initializer);
        if (value && ts.isIdentifier(node.name)) assign(node.name, value);
        else if (value === "process" && ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements)
            if (
              (element.propertyName ?? element.name).getText(file) === "dlopen" &&
              ts.isIdentifier(element.name)
            )
              assign(element.name, "dlopen");
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (!changed) break;
  }
  return origin;
}

function collectReferences(module: ScannableModule): ReadonlyArray<ModuleReference> {
  const file = parse(module);
  const refs: ModuleReference[] = [];
  const requireBindings = nodeRequireBindings(file, module.format);
  const nativeOrigin = nativeLoaderBindings(file);
  const add = (
    specifier: string,
    node: ts.Node,
    kind: ModuleReference["kind"],
    literalValue: boolean,
  ) => {
    refs.push({ ...location(file, module, node), kind, specifier, literal: literalValue });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier as ts.Expression);
      if (specifier !== undefined) add(specifier, node.moduleSpecifier, "static-import", true);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (dynamicImport || isNodeRequireCall(node, requireBindings)) {
        const specifier = literal(node.arguments[0]);
        if (specifier === undefined)
          add("<dynamic>", node.expression, dynamicImport ? "dynamic-import" : "require", false);
        else add(specifier, node.arguments[0]!, dynamicImport ? "dynamic-import" : "require", true);
      } else if (nativeOrigin(node.expression) === "dlopen") {
        const filename = literal(node.arguments[1]);
        if (filename === undefined)
          add("<dynamic>", node.arguments[1] ?? node.expression, "native-load", false);
        else add(filename, node.arguments[1]!, "napi-reference", true);
      } else if (node.arguments.length && literal(node.arguments[0]) !== undefined) {
        const specifier = literal(node.arguments[0])!;
        // NAPI refs are internal graph edges too. Preserve relative paths so
        // resolveTarget can resolve them from the importing module's key.
        if (specifier.endsWith(".node")) add(specifier, node.arguments[0]!, "napi-reference", true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const escaped of [
    ...nodeRequireEscapes(file, requireBindings),
    ...factoryRequireEscapes(file, requireBindings),
  ])
    add("<dynamic>", escaped, "require-escape", false);
  return refs;
}

function resolveTarget(
  specifier: string,
  from: string,
  byKey: ReadonlyMap<string, number>,
): number | undefined {
  const normalized = normalizeKey(specifier);
  const exact = byKey.get(normalized);
  if (exact !== undefined) return exact;
  if (!specifier.startsWith(".")) return undefined;
  const stack = normalizeKey(`${from.slice(0, from.lastIndexOf("/") + 1)}${specifier}`)
    .split("/")
    .filter(Boolean);
  const output: string[] = [];
  for (const part of stack) {
    if (part === "..") output.pop();
    else if (part !== ".") output.push(part);
  }
  const key = output.join("/");
  return byKey.get(key) ?? byKey.get(`${key}.js`) ?? byKey.get(`${key}/index.js`);
}

function isInternal(specifier: string): boolean {
  return /^(?:\/?\$bunfs\/|\/?~BUN\/)/u.test(specifier) || specifier.startsWith(".");
}

/** Trace literal module edges from Bun's graph entry. Dynamic or missing edges stay explicit. */
export function traceReleaseReachability(
  modules: ReadonlyArray<ScannableModule>,
  entryIndex: number,
  providedModuleNames: ReadonlyArray<string> = [],
): Reachability {
  const ordered = [...modules].sort((a, b) => a.index - b.index);
  const byIndex = new Map(ordered.map((module) => [module.index, module]));
  const byKey = new Map(ordered.map((module) => [normalizeKey(module.key), module.index]));
  if (!byIndex.has(entryIndex)) throw new Error(`Graph entry module ${entryIndex} is absent`);
  const references = new Map<number, ReadonlyArray<ModuleReference>>();
  const indexes = new Set<number>();
  const unresolvedReferences: UnresolvedReference[] = [];
  const unresolvedBareReferences: UnresolvedReference[] = [];
  const provided = new Set(
    providedModuleNames.map((name) => (name.startsWith("node:") ? name.slice(5) : name)),
  );
  const queue = [entryIndex];
  while (queue.length) {
    const index = queue.shift()!;
    if (indexes.has(index)) continue;
    indexes.add(index);
    const module = byIndex.get(index);
    if (!module || module.loader !== 1) continue;
    let moduleReferences = references.get(index);
    if (!moduleReferences) {
      moduleReferences = collectReferences(module);
      references.set(index, moduleReferences);
    }
    for (const reference of moduleReferences) {
      const { literal, ...details } = reference;
      if (!literal) {
        unresolvedReferences.push({
          ...details,
          kind:
            reference.kind === "dynamic-import"
              ? "dynamic-import"
              : reference.kind === "native-load"
                ? "dynamic-native-load"
                : "dynamic-require",
        });
        continue;
      }
      const target = resolveTarget(reference.specifier, module.key, byKey);
      if (target !== undefined) {
        queue.push(target);
        continue;
      }
      if (isInternal(reference.specifier)) {
        unresolvedReferences.push({ ...details, kind: "internal-module" });
        continue;
      }
      const normalized = reference.specifier.startsWith("node:")
        ? reference.specifier.slice(5)
        : reference.specifier;
      const root = normalized.split("/")[0]!;
      if (
        !provided.has(normalized) &&
        !provided.has(root) &&
        !reference.specifier.startsWith("node:")
      ) {
        unresolvedBareReferences.push({ ...details, kind: "bare-module" });
      }
    }
  }
  const order = (a: UnresolvedReference, b: UnresolvedReference) =>
    compare(a.module, b.module) || a.offset - b.offset || compare(a.specifier, b.specifier);
  return {
    indexes,
    unresolvedReferences: unresolvedReferences.sort(order),
    unresolvedBareReferences: unresolvedBareReferences.sort(order),
  };
}
