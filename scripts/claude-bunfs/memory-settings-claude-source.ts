import ts from "typescript-legacy";
import { ScopedBindings } from "./release-inventory-scope.ts";
import {
  createPinnedEnvironmentTransform,
  isPinnedEnvironmentWrite,
} from "./pinned-environment.ts";

type Source = {
  readonly name: string;
  readonly text: string;
  readonly file: ts.SourceFile;
  readonly bindings: ScopedBindings<never>;
};
type FunctionWithBody = ts.FunctionLikeDeclaration & { readonly body: ts.Block | ts.Expression };
type Value = { readonly source: Source; readonly node: ts.Expression | FunctionWithBody };
type Read = {
  readonly key: string;
  readonly source: Source;
  readonly node: ts.Expression;
  readonly type: "string" | "integer" | "triBoolean" | "unknown";
  readonly range: "proven" | "unproven" | "changed";
  readonly descriptor?: Value;
};

export interface ClaudeDefaultEvidence {
  readonly key: string;
  readonly source: string;
  readonly default: string | undefined;
  readonly changed: boolean;
}

export interface ClaudeRetentionInspection {
  readonly key: string;
  readonly source: string | undefined;
  readonly explicitValue: string;
  readonly honored: boolean;
}

/** Supports native process reads and Claude's typed environment registry. */
class ClaudePinnedSources {
  private readonly raw: ReadonlyMap<string, string>;
  private readonly modules = new Map<string, Source>();
  private readonly basenames = new Map<string, string[]>();
  private readonly native: ReturnType<typeof createPinnedEnvironmentTransform>;

  constructor(sources: ReadonlyMap<string, string>, pins: Readonly<Record<string, string>>) {
    this.raw = sources;
    for (const name of sources.keys()) {
      const basename = name.slice(name.lastIndexOf("/") + 1);
      this.basenames.set(basename, [...(this.basenames.get(basename) ?? []), name]);
    }
    this.native = createPinnedEnvironmentTransform(
      sources,
      Object.fromEntries(Object.keys(pins).map((key) => [key, null])),
      (_specifier, importer) => this.resolve(importer, _specifier)?.name,
    );
  }

  candidates(fragment: string): Source[] {
    const result: Source[] = [];
    for (const [name, text] of this.raw)
      if (text.includes(fragment)) result.push(this.source(name)!);
    return result;
  }

  reads(key: string, pin: string): Read[] {
    const result: Read[] = [];
    for (const source of this.candidates(key)) {
      const nativeReads = new Set(
        this.native
          .inspect(source.text, source.name)
          .filter((access) => access.key === key)
          .map((access) => `${access.start}:${access.end}`),
      );
      const visit = (node: ts.Node): void => {
        if (
          (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
          property(node) === key &&
          !isPinnedEnvironmentWrite(node)
        ) {
          if (nativeReads.has(`${node.getStart(source.file)}:${node.end}`)) {
            result.push({ key, source, node, type: "string", range: "proven" });
          } else {
            const typed = this.typedRead(source, node, key, Number(pin));
            if (typed) result.push({ key, source, node, ...typed });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source.file);
    }
    return result;
  }

  functionValue(source: Source, expression: ts.Expression): Value | undefined {
    const value = this.value(source, unwrap(expression));
    if (value && isFunction(value.node)) return value;
    return value && ts.isIdentifier(value.node)
      ? this.functionValue(value.source, value.node)
      : undefined;
  }

  number(source: Source, expression: ts.Expression, seen = new Set<string>()): number | undefined {
    expression = unwrap(expression);
    if (ts.isNumericLiteral(expression)) {
      const value = Number(expression.text);
      return Number.isFinite(value) ? value : undefined;
    }
    if (
      ts.isPrefixUnaryExpression(expression) &&
      (expression.operator === ts.SyntaxKind.MinusToken ||
        expression.operator === ts.SyntaxKind.PlusToken)
    ) {
      const value = this.number(source, expression.operand, seen);
      return value === undefined
        ? undefined
        : expression.operator === ts.SyntaxKind.MinusToken
          ? -value
          : value;
    }
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration = source.bindings.lookup(expression)?.declaration;
    if (!declaration) return undefined;
    const token = `${source.name}\0${declaration.pos}`;
    if (seen.has(token)) return undefined;
    seen.add(token);
    const value = this.value(source, expression);
    return value && ts.isExpression(value.node)
      ? this.number(value.source, value.node, seen)
      : undefined;
  }

  isTriBoolOne(descriptor: Value | undefined): boolean {
    if (!descriptor) return false;
    const resolved = this.value(descriptor.source, descriptor.node as ts.Expression);
    if (!resolved || !ts.isCallExpression(unwrap(resolved.node as ts.Expression))) return false;
    const call = unwrap(resolved.node as ts.Expression) as ts.CallExpression;
    const callee = unwrap(call.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "triBool" ||
      !ts.isIdentifier(callee.expression)
    )
      return false;
    const helpers = this.value(resolved.source, callee.expression);
    if (
      !helpers ||
      !ts.isExpression(helpers.node) ||
      !ts.isObjectLiteralExpression(unwrap(helpers.node))
    )
      return false;
    const triBool = (unwrap(helpers.node) as ts.ObjectLiteralExpression).properties.find(
      (item) => propertyName(item.name) === "triBool",
    );
    if (!triBool || !ts.isPropertyAssignment(triBool) || !ts.isExpression(triBool.initializer))
      return false;
    const parser = this.value(helpers.source, triBool.initializer);
    if (
      !parser ||
      !isFunction(parser.node) ||
      !ts.isExpression(parser.node.body) ||
      !ts.isIdentifier(unwrap(parser.node.body))
    )
      return false;
    const parserValue = this.value(parser.source, unwrap(parser.node.body) as ts.Identifier);
    if (
      !parserValue ||
      !ts.isExpression(parserValue.node) ||
      !ts.isCallExpression(unwrap(parserValue.node))
    )
      return false;
    const parserCall = unwrap(parserValue.node) as ts.CallExpression;
    const callback = parserCall.arguments[0] && unwrap(parserCall.arguments[0]);
    if (!callback || !isFunction(callback)) return false;
    const parameter = callback.parameters[0]?.name;
    if (!ts.isBlock(callback.body) || !parameter || !ts.isIdentifier(parameter)) return false;
    const first = callback.body.statements[0];
    if (
      !first ||
      !ts.isIfStatement(first) ||
      first.elseStatement ||
      !ts.isCallExpression(first.expression) ||
      !ts.isReturnStatement(first.thenStatement) ||
      !first.thenStatement.expression ||
      !isTrue(first.thenStatement.expression)
    )
      return false;
    const argument = first.expression.arguments[0];
    if (
      !argument ||
      !ts.isIdentifier(argument) ||
      helpers.source.bindings.lookup(argument)?.declaration !==
        helpers.source.bindings.lookup(parameter)?.declaration
    )
      return false;
    const trueParser = this.functionValue(helpers.source, first.expression.expression);
    const factory = this.functionValue(parserValue.source, parserCall.expression);
    if (
      !trueParser ||
      !factory ||
      !matchesFunctionBody(
        trueParser,
        `function truthy(e) {
      if (!e) return !1;
      if (typeof e === "boolean") return e;
      let n = String(e).toLowerCase().trim();
      return ["1", "true", "yes", "on"].includes(n);
    }`,
      ) ||
      !matchesFunctionBody(
        factory,
        `function convert(e) {}
      function factory(n) { return { parse: (e) => n(convert(e)) }; }`,
      )
    )
      return false;
    let converter: Value | undefined;
    walk(factory.node, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const target = this.functionValue(factory.source, node.expression);
      if (target) converter = target;
    });
    return (
      !!converter &&
      matchesFunctionBody(
        converter,
        `function convert(n) {
      return n === void 0 ? void 0 : String(n);
    }`,
      )
    );
  }

  private resolve(_importer: string, specifier: string): Source | undefined {
    const direct = this.source(specifier.replace(/^bun-graph:/, ""));
    if (direct) return direct;
    const basename = specifier.slice(specifier.lastIndexOf("/") + 1);
    const matches = this.basenames.get(basename);
    return matches?.length === 1 ? this.source(matches[0]!) : undefined;
  }

  private source(name: string): Source | undefined {
    const cached = this.modules.get(name);
    if (cached) return cached;
    const text = this.raw.get(name);
    if (text === undefined) return undefined;
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const source = { name, text, file, bindings: new ScopedBindings<never>(file) };
    this.modules.set(name, source);
    return source;
  }

  value(source: Source, expression: ts.Expression, seen = new Set<string>()): Value | undefined {
    expression = unwrap(expression);
    if (!ts.isIdentifier(expression)) return { source, node: expression };
    const declaration = source.bindings.lookup(expression)?.declaration;
    if (!declaration) return undefined;
    const token = `${source.name}\0${declaration.pos}`;
    if (seen.has(token)) return undefined;
    seen.add(token);
    if (ts.isVariableDeclaration(declaration.parent) && declaration.parent.name === declaration)
      return declaration.parent.initializer
        ? { source, node: declaration.parent.initializer }
        : undefined;
    if (
      (ts.isFunctionDeclaration(declaration.parent) ||
        ts.isMethodDeclaration(declaration.parent)) &&
      declaration.parent.name === declaration &&
      isFunction(declaration.parent)
    )
      return { source, node: declaration.parent };
    const imported = importOf(source, declaration);
    if (!imported) return undefined;
    const target = this.resolve(source.name, imported.specifier);
    return target ? this.exportValue(target, imported.name, seen) : undefined;
  }

  private exportValue(source: Source, name: string, seen = new Set<string>()): Value | undefined {
    const token = `${source.name}\0export\0${name}`;
    if (seen.has(token)) return undefined;
    seen.add(token);
    for (const statement of source.file.statements) {
      if (ts.isExportAssignment(statement) && name === "default")
        return { source, node: statement.expression };
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const item = statement.exportClause.elements.find((element) => element.name.text === name);
        if (!item) continue;
        const local = (item.propertyName ?? item.name).text;
        if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const target = this.resolve(source.name, statement.moduleSpecifier.text);
          return target ? this.exportValue(target, local, seen) : undefined;
        }
        return this.localValue(source, local);
      }
      if (
        (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        const local = ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.find(
              (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
            )
          : statement.name?.text === name
            ? statement
            : undefined;
        if (local) return this.localValue(source, name);
      }
    }
    return undefined;
  }

  private localValue(source: Source, name: string): Value | undefined {
    const statement = source.file.statements.find((item) => {
      if (ts.isVariableStatement(item))
        return item.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        );
      return (
        (ts.isFunctionDeclaration(item) || ts.isClassDeclaration(item)) && item.name?.text === name
      );
    });
    if (!statement) return undefined;
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      return declaration?.initializer ? { source, node: declaration.initializer } : undefined;
    }
    return isFunction(statement) ? { source, node: statement } : undefined;
  }

  private typedRead(
    source: Source,
    read: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    key: string,
    pin: number,
  ): Omit<Read, "key" | "source" | "node"> | undefined {
    if (!ts.isIdentifier(read.expression)) return undefined;
    const settingObject = this.value(source, read.expression);
    if (!settingObject || !ts.isExpression(settingObject.node)) return undefined;
    const call = unwrap(settingObject.node);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined;
    const registry = call.arguments[0];
    if (!registry || !ts.isIdentifier(registry)) return undefined;
    const builder = this.functionValue(settingObject.source, call.expression);
    if (!builder || !this.isCanonicalSettingsBuilder(builder)) return undefined;
    const descriptor = this.registryDescriptor(settingObject.source, registry, key);
    if (!descriptor) return undefined;
    const descriptorCall = this.descriptorCall(descriptor);
    if (!descriptorCall) return { type: "unknown", range: "unproven", descriptor };
    if (descriptorCall.name === "triBool")
      return { type: "triBoolean", range: "unproven", descriptor };
    if (descriptorCall.name !== "int") return { type: "unknown", range: "unproven", descriptor };
    const range = this.intRange(descriptorCall.call, pin);
    if (!range) return { type: "unknown", range: "unproven", descriptor };
    return { type: "integer", range: range.changed ? "changed" : "proven", descriptor };
  }

  private isCanonicalSettingsBuilder(value: Value): boolean {
    if (!isFunction(value.node) || !ts.isBlock(value.node.body)) return false;
    const registryParam = value.node.parameters[0]?.name;
    if (!registryParam || !ts.isIdentifier(registryParam)) return false;
    const registryBinding = value.source.bindings.lookup(registryParam)?.declaration;
    if (!registryBinding) return false;
    let matched = false;
    walkWithoutNestedFunctions(value.node.body, (node) => {
      if (matched || !ts.isForOfStatement(node)) return;
      const declaration =
        ts.isVariableDeclarationList(node.initializer) && node.initializer.declarations.length === 1
          ? node.initializer.declarations[0]
          : undefined;
      if (!declaration || !ts.isArrayBindingPattern(declaration.name)) return;
      const [keyPart, descriptorPart] = declaration.name.elements;
      if (
        !keyPart ||
        !ts.isBindingElement(keyPart) ||
        !ts.isIdentifier(keyPart.name) ||
        !descriptorPart ||
        !ts.isBindingElement(descriptorPart) ||
        !ts.isIdentifier(descriptorPart.name)
      )
        return;
      const keyBinding = value.source.bindings.lookup(keyPart.name)?.declaration;
      const descriptorBinding = value.source.bindings.lookup(descriptorPart.name)?.declaration;
      if (
        !keyBinding ||
        !descriptorBinding ||
        !this.entriesOfRegistry(value.source, node.expression, registryBinding)
      )
        return;
      walkWithoutNestedFunctions(node.statement, (child) => {
        if (
          matched ||
          !ts.isCallExpression(child) ||
          !isGlobalObjectCall(value.source, child.expression, "defineProperty")
        )
          return;
        const [target, key, shape] = child.arguments;
        if (
          !target ||
          !key ||
          !ts.isIdentifier(key) ||
          value.source.bindings.lookup(key)?.declaration !== keyBinding ||
          !shape ||
          !ts.isObjectLiteralExpression(shape)
        )
          return;
        const getter = shape.properties.find((part) => propertyName(part.name) === "get");
        const getterCall =
          getter && ts.isPropertyAssignment(getter) ? unwrap(getter.initializer) : undefined;
        if (!getterCall || !ts.isCallExpression(getterCall)) return;
        const [getKey, getDescriptor] = getterCall.arguments;
        if (
          !getKey ||
          !ts.isIdentifier(getKey) ||
          value.source.bindings.lookup(getKey)?.declaration !== keyBinding ||
          !getDescriptor ||
          !ts.isIdentifier(getDescriptor) ||
          value.source.bindings.lookup(getDescriptor)?.declaration !== descriptorBinding
        )
          return;
        const getterFactory = this.functionValue(value.source, getterCall.expression);
        matched = !!getterFactory && this.isCanonicalGetter(getterFactory);
      });
    });
    return matched;
  }

  private entriesOfRegistry(
    source: Source,
    expression: ts.Expression,
    registry: ts.Identifier,
  ): boolean {
    expression = unwrap(expression);
    if (ts.isConditionalExpression(expression))
      return (
        this.entriesOfRegistry(source, expression.whenTrue, registry) ||
        this.entriesOfRegistry(source, expression.whenFalse, registry)
      );
    if (
      !ts.isCallExpression(expression) ||
      !isGlobalObjectCall(source, expression.expression, "entries")
    )
      return false;
    const argument = expression.arguments[0];
    return (
      !!argument &&
      ts.isIdentifier(argument) &&
      source.bindings.lookup(argument)?.declaration === registry
    );
  }

  private isCanonicalGetter(value: Value): boolean {
    if (!isFunction(value.node)) return false;
    const key = value.node.parameters[0]?.name;
    const descriptor = value.node.parameters[1]?.name;
    if (
      !key ||
      !ts.isIdentifier(key) ||
      !descriptor ||
      !ts.isIdentifier(descriptor) ||
      !ts.isBlock(value.node.body)
    )
      return false;
    const keyBinding = value.source.bindings.lookup(key)?.declaration;
    const descriptorBinding = value.source.bindings.lookup(descriptor)?.declaration;
    if (!keyBinding || !descriptorBinding) return false;
    let envRead = false;
    let parseCall = false;
    let returnsClosure = false;
    walk(value.node.body, (node) => {
      if (ts.isReturnStatement(node) && node.expression && isFunction(node.expression)) {
        let nestedEnvRead = false;
        walk(node.expression.body, (child) => {
          if (isProcessEnvRead(value.source, child, keyBinding)) nestedEnvRead = true;
        });
        returnsClosure ||= nestedEnvRead;
      }
      if (isProcessEnvRead(value.source, node, keyBinding)) envRead = true;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "parse" &&
        ts.isIdentifier(node.expression.expression) &&
        value.source.bindings.lookup(node.expression.expression)?.declaration === descriptorBinding
      )
        parseCall = true;
    });
    return returnsClosure && envRead && parseCall;
  }

  private registryDescriptor(
    source: Source,
    registry: ts.Identifier,
    key: string,
  ): Value | undefined {
    const registryValue = this.value(source, registry);
    if (
      !registryValue ||
      !ts.isExpression(registryValue.node) ||
      !ts.isObjectLiteralExpression(unwrap(registryValue.node))
    )
      return undefined;
    const object = unwrap(registryValue.node) as ts.ObjectLiteralExpression;
    const tables = new Set(
      object.properties.flatMap((property) => {
        if (!ts.isSpreadAssignment(property) || !ts.isIdentifier(property.expression)) return [];
        const binding = registryValue.source.bindings.lookup(property.expression)?.declaration;
        return binding ? [binding] : [];
      }),
    );
    for (const module of this.candidates(key)) {
      let result: Value | undefined;
      walk(module.file, (node) => {
        if (result || !ts.isCallExpression(node) || node.arguments.length < 2) return;
        const [target, descriptors] = node.arguments;
        if (
          !target ||
          !ts.isIdentifier(target) ||
          !descriptors ||
          !ts.isObjectLiteralExpression(descriptors)
        )
          return;
        const targetBinding = module.bindings.lookup(target)?.declaration;
        if (
          !targetBinding ||
          !tables.has(targetBinding) ||
          !this.isCanonicalMr(module, node.expression)
        )
          return;
        const member = descriptors.properties.find(
          (property) => propertyName(property.name) === key,
        );
        if (member && ts.isPropertyAssignment(member))
          result = this.descriptorValue(module, member.initializer);
      });
      if (result) return result;
    }
    return undefined;
  }

  private isCanonicalMr(source: Source, expression: ts.Expression): boolean {
    const helper = this.functionValue(source, expression);
    if (
      !helper ||
      !isFunction(helper.node) ||
      helper.node.parameters.length < 2 ||
      !ts.isBlock(helper.node.body)
    )
      return false;
    const target = helper.node.parameters[0]?.name;
    const descriptors = helper.node.parameters[1]?.name;
    if (!target || !ts.isIdentifier(target) || !descriptors || !ts.isIdentifier(descriptors))
      return false;
    const targetBinding = helper.source.bindings.lookup(target)?.declaration;
    const descriptorBinding = helper.source.bindings.lookup(descriptors)?.declaration;
    if (!targetBinding || !descriptorBinding) return false;
    let matched = false;
    walkWithoutNestedFunctions(helper.node.body, (node) => {
      if (
        matched ||
        !ts.isForInStatement(node) ||
        !ts.isIdentifier(node.expression) ||
        helper.source.bindings.lookup(node.expression)?.declaration !== descriptorBinding
      )
        return;
      const key = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations[0]?.name
        : node.initializer;
      if (!key || !ts.isIdentifier(key)) return;
      const keyBinding = helper.source.bindings.lookup(key)?.declaration;
      walkWithoutNestedFunctions(node.statement, (child) => {
        if (matched || !ts.isCallExpression(child) || child.arguments.length < 3) return;
        const [to, property, shape] = child.arguments;
        if (
          !to ||
          !ts.isIdentifier(to) ||
          helper.source.bindings.lookup(to)?.declaration !== targetBinding ||
          !property ||
          !ts.isIdentifier(property) ||
          helper.source.bindings.lookup(property)?.declaration !== keyBinding ||
          !shape ||
          !ts.isObjectLiteralExpression(shape)
        )
          return;
        const getter = shape.properties.find((item) => propertyName(item.name) === "get");
        const access =
          getter && ts.isPropertyAssignment(getter) ? unwrap(getter.initializer) : undefined;
        if (
          access &&
          ts.isElementAccessExpression(access) &&
          ts.isIdentifier(access.expression) &&
          helper.source.bindings.lookup(access.expression)?.declaration === descriptorBinding &&
          access.argumentExpression &&
          ts.isIdentifier(access.argumentExpression) &&
          helper.source.bindings.lookup(access.argumentExpression)?.declaration === keyBinding
        )
          matched = true;
      });
    });
    return matched;
  }

  private descriptorValue(source: Source, expression: ts.Expression): Value | undefined {
    expression = unwrap(expression);
    if (isFunction(expression)) {
      if (ts.isExpression(expression.body)) return this.descriptorValue(source, expression.body);
      if (expression.body.statements.length === 1) {
        const statement = expression.body.statements[0];
        if (statement && ts.isReturnStatement(statement) && statement.expression)
          return this.descriptorValue(source, statement.expression);
      }
      return undefined;
    }
    return this.value(source, expression);
  }

  private descriptorCall(
    descriptor: Value,
  ):
    | { readonly name: string; readonly call: ts.CallExpression; readonly source: Source }
    | undefined {
    const value = this.value(descriptor.source, descriptor.node as ts.Expression);
    if (!value || !ts.isExpression(value.node) || !ts.isCallExpression(unwrap(value.node)))
      return undefined;
    const call = unwrap(value.node) as ts.CallExpression;
    const callee = unwrap(call.expression);
    return ts.isPropertyAccessExpression(callee)
      ? { name: callee.name.text, call, source: value.source }
      : undefined;
  }

  private intRange(call: ts.CallExpression, pin: number): { changed: boolean } | undefined {
    if (call.arguments.length > 1) return undefined;
    let min = Number.NEGATIVE_INFINITY;
    let max = Number.POSITIVE_INFINITY;
    if (call.arguments[0]) {
      const options = unwrap(call.arguments[0]!);
      if (!ts.isObjectLiteralExpression(options)) return undefined;
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) return undefined;
        const value = literalNumber(property.initializer);
        const name = propertyName(property.name);
        if (name === "min" && value !== undefined) min = value;
        else if (name === "max" && value !== undefined) max = value;
        else if (name !== "digitsOnly") return undefined;
      }
    }
    return { changed: pin < min || pin > max };
  }
}

export function inspectClaudeMemorySettingSources(
  sources: ReadonlyMap<string, string>,
  pins: Readonly<Record<string, string>>,
): ClaudeDefaultEvidence[] {
  const pkg = new ClaudePinnedSources(sources, pins);
  return Object.keys(pins).map((key) => {
    const reads = pkg.reads(key, pins[key]!);
    if (!reads.length) return { key, source: "", default: undefined, changed: false };
    const observations = reads.map((read) => defaultForRead(pkg, read, Number(pins[key])));
    const values = observations.map((value) => value?.value);
    const proven = new Set(values.filter((value): value is number => value !== undefined));
    return {
      key,
      source: reads[0]!.source.name,
      default:
        proven.size === 1 && values.every((value) => value !== undefined)
          ? String([...proven][0])
          : undefined,
      changed:
        reads.some((read) => read.range === "changed") ||
        observations.some((value) => value?.changed === true),
    };
  });
}

export function inspectClaudeMemoryRetentionSources(
  sources: ReadonlyMap<string, string>,
  retentionPins: Readonly<Record<string, string>>,
): ClaudeRetentionInspection[] {
  const pkg = new ClaudePinnedSources(sources, retentionPins);
  return Object.entries(retentionPins).map(([key, explicitValue]) => {
    const reads = pkg.reads(key, explicitValue);
    const honored =
      explicitValue === "1" &&
      reads.some((read) => retentionPathIsHonored(pkg, read, explicitValue));
    return { key, source: reads[0]?.source.name, explicitValue, honored };
  });
}

function defaultForRead(
  pkg: ClaudePinnedSources,
  read: Read,
  pin: number,
): { readonly value: number; readonly changed: boolean } | undefined {
  if (read.range !== "proven") return undefined;
  let value: ts.Expression = read.node;
  let parent = value.parent;
  while (parent && ts.isCallExpression(parent)) {
    const callee = unwrap(parent.expression);
    if (
      !ts.isIdentifier(callee) ||
      callee.text !== "Number" ||
      read.source.bindings.lookup(callee) ||
      parent.arguments.length !== 1 ||
      unwrap(parent.arguments[0]!) !== value
    )
      break;
    value = parent;
    parent = parent.parent;
  }
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    unwrap(parent.left) === value
  ) {
    const fallback = pkg.number(read.source, parent.right);
    return fallback === undefined ? undefined : { value: fallback, changed: false };
  }
  const parser = parserDefault(pkg, read, pin);
  if (parser) return parser;
  const owner = enclosingFunction(read.source, read.node);
  if (!owner || !functionReturnsRead(read, owner)) return undefined;
  const fallbacks: Array<number | undefined> = [];
  walk(read.source.file, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
      !ts.isCallExpression(unwrap(node.left))
    )
      return;
    const call = unwrap(node.left) as ts.CallExpression;
    const target = pkg.functionValue(read.source, call.expression);
    if (target?.source === owner.source && target.node === owner.node)
      fallbacks.push(pkg.number(read.source, node.right));
  });
  if (!fallbacks.length || fallbacks.some((fallback) => fallback === undefined)) return undefined;
  const values = new Set(fallbacks as number[]);
  return values.size === 1 ? { value: [...values][0]!, changed: false } : undefined;
}

function parserDefault(
  pkg: ClaudePinnedSources,
  read: Read,
  pin: number,
): { readonly value: number; readonly changed: boolean } | undefined {
  const call = read.node.parent;
  if (!call || !ts.isCallExpression(call)) return undefined;
  const argIndex = call.arguments.findIndex((argument) => unwrap(argument) === read.node);
  const key = call.arguments[0] && unwrap(call.arguments[0]);
  if (
    argIndex !== 1 ||
    !key ||
    !ts.isStringLiteralLike(key) ||
    key.text !== read.key ||
    call.arguments.length < 3
  )
    return undefined;
  const parser = pkg.functionValue(read.source, call.expression);
  if (!parser || !hasCanonicalFallbackParser(parser)) return undefined;
  const value = call.arguments[2] && pkg.number(read.source, call.arguments[2]);
  if (value === undefined) return undefined;
  const upper = call.arguments[3] && pkg.number(read.source, call.arguments[3]);
  if (call.arguments.length > 3 && upper === undefined) return undefined;
  return { value, changed: upper !== undefined && upper < pin };
}

function hasCanonicalFallbackParser(value: Value): boolean {
  if (!isFunction(value.node) || value.node.parameters.length < 4 || !ts.isBlock(value.node.body))
    return false;
  const input = value.node.parameters[1]?.name;
  const fallback = value.node.parameters[2]?.name;
  const upper = value.node.parameters[3]?.name;
  if (
    !input ||
    !ts.isIdentifier(input) ||
    !fallback ||
    !ts.isIdentifier(fallback) ||
    !upper ||
    !ts.isIdentifier(upper)
  )
    return false;
  const inputBinding = value.source.bindings.lookup(input)?.declaration;
  const fallbackBinding = value.source.bindings.lookup(fallback)?.declaration;
  const upperBinding = value.source.bindings.lookup(upper)?.declaration;
  if (!inputBinding || !fallbackBinding || !upperBinding) return false;
  let fallbackOnMissing = false;
  let capsToUpper = false;
  walkWithoutNestedFunctions(value.node.body, (node) => {
    if (!ts.isIfStatement(node)) return;
    const condition = unwrap(node.expression);
    if (
      ts.isPrefixUnaryExpression(condition) &&
      condition.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(condition.operand) &&
      value.source.bindings.lookup(condition.operand)?.declaration === inputBinding
    )
      fallbackOnMissing ||= returnsEffective(value.source, node.thenStatement, fallbackBinding);
    if (
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
      ts.isIdentifier(unwrap(condition.right)) &&
      value.source.bindings.lookup(unwrap(condition.right) as ts.Identifier)?.declaration ===
        upperBinding
    )
      capsToUpper ||= returnsEffective(value.source, node.thenStatement, upperBinding);
  });
  return fallbackOnMissing && capsToUpper;
}

function returnsEffective(
  source: Source,
  statement: ts.Statement,
  binding: ts.Identifier,
): boolean {
  let found = false;
  walkWithoutNestedFunctions(statement, (node) => {
    if (!ts.isReturnStatement(node) || !node.expression) return;
    const expression = returnedValue(source, node.expression);
    if (!expression) return;
    if (!ts.isObjectLiteralExpression(expression)) return;
    const effective = expression.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) && propertyName(property.name) === "effective",
    );
    if (
      effective &&
      ts.isPropertyAssignment(effective) &&
      ts.isIdentifier(unwrap(effective.initializer)) &&
      source.bindings.lookup(unwrap(effective.initializer) as ts.Identifier)?.declaration ===
        binding
    )
      found = true;
  });
  return found;
}

function returnedValue(
  source: Source,
  expression: ts.Expression,
  seen = new Set<ts.Identifier>(),
): ts.Expression | undefined {
  expression = unwrap(expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.CommaToken
  )
    return returnedValue(source, expression.right, seen);
  if (!ts.isIdentifier(expression)) return expression;
  const binding = source.bindings.lookup(expression)?.declaration;
  if (
    !binding ||
    seen.has(binding) ||
    !ts.isVariableDeclaration(binding.parent) ||
    !binding.parent.initializer
  )
    return undefined;
  seen.add(binding);
  return returnedValue(source, binding.parent.initializer, seen);
}

function enclosingFunction(source: Source, node: ts.Node): Value | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent)
    if (isFunction(current)) return { source, node: current };
  return undefined;
}

function functionReturnsRead(read: Read, owner: Value): boolean {
  if (!isFunction(owner.node) || !ts.isBlock(owner.node.body)) return false;
  const declaration = read.node.parent;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== read.node ||
    !ts.isIdentifier(declaration.name)
  )
    return false;
  const binding = read.source.bindings.lookup(declaration.name)?.declaration;
  if (!binding) return false;
  let returned = false;
  let unsupported = false;
  walkWithoutNestedFunctions(owner.node.body, (node) => {
    if (
      !ts.isReturnStatement(node) ||
      !node.expression ||
      isUndefined(read.source, node.expression)
    )
      return;
    const expression = unwrap(node.expression);
    if (
      ts.isIdentifier(expression) &&
      read.source.bindings.lookup(expression)?.declaration === binding
    )
      returned = true;
    else unsupported = true;
  });
  return returned && !unsupported;
}

function retentionPathIsHonored(
  pkg: ClaudePinnedSources,
  read: Read,
  explicitValue: string,
): boolean {
  if (read.type === "triBoolean" && !pkg.isTriBoolOne(read.descriptor)) return false;
  if (read.type !== "triBoolean" && read.type !== "string") return false;
  const expected = read.type === "triBoolean" ? "boolean" : "string";
  let comparison: ts.BinaryExpression | undefined;
  let controllingIf: ts.IfStatement | undefined;
  for (let current: ts.Node | undefined = read.node; current; current = current.parent) {
    if (
      ts.isBinaryExpression(current) &&
      isEquality(current.operatorToken.kind) &&
      comparisonMatches(current, read.node, expected, explicitValue)
    )
      comparison = current;
    if (ts.isIfStatement(current) && comparison && isDescendantOf(comparison, current.expression)) {
      controllingIf = current;
      break;
    }
  }
  if (!comparison || !controllingIf || !onlyConjunctionPath(comparison, controllingIf.expression))
    return false;
  const isEqualOperator =
    comparison.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
    comparison.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const branch = isEqualOperator ? controllingIf.thenStatement : controllingIf.elseStatement;
  const path = branch ? callsGcSetter(pkg, read.source, branch) : undefined;
  return (
    !!path &&
    hasLocalGcSetter(path.setterClass, path.source) &&
    hasRequestCompactGate(path.requestClass, path.source)
  );
}

function comparisonMatches(
  node: ts.BinaryExpression,
  read: ts.Expression,
  type: "string" | "boolean",
  explicitValue: string,
): boolean {
  const left = unwrap(node.left);
  const right = unwrap(node.right);
  const operand = left === read ? right : right === read ? left : undefined;
  if (!operand) return false;
  if (type === "boolean") return isTrue(operand);
  return ts.isStringLiteralLike(operand) && operand.text === explicitValue;
}

function isEquality(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function onlyConjunctionPath(node: ts.Node, root: ts.Node): boolean {
  let current = node;
  while (current !== root) {
    const parent = current.parent;
    if (!parent) return false;
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if (
      !ts.isBinaryExpression(parent) ||
      parent.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
    )
      return false;
    current = parent;
  }
  return true;
}

interface RetentionPath {
  readonly source: Source;
  readonly setterClass: ts.ClassLikeDeclaration;
  readonly requestClass: ts.ClassLikeDeclaration;
}

function callsGcSetter(
  pkg: ClaudePinnedSources,
  source: Source,
  statement: ts.Statement,
): RetentionPath | undefined {
  const call = singleCallStatement(statement);
  if (!call) return undefined;
  const argument = call.arguments[0] && unwrap(call.arguments[0]);
  if (!argument || !isTrue(argument)) return undefined;
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "setLocalGcEnabled") {
    const instanceClass = classForInstance(source, callee.expression);
    return instanceClass
      ? { source, setterClass: instanceClass, requestClass: instanceClass }
      : undefined;
  }
  if (!ts.isIdentifier(callee)) return undefined;
  const helper = pkg.functionValue(source, callee);
  const receiver = helper && forwardedGcReceiver(helper);
  return receiver && helper ? singletonGcPath(pkg, helper.source, receiver) : undefined;
}

function forwardedGcReceiver(value: Value): ts.Expression | undefined {
  if (!isFunction(value.node)) return undefined;
  const parameter = value.node.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return undefined;
  const binding = value.source.bindings.lookup(parameter)?.declaration;
  if (!binding) return undefined;
  const call = singleCallStatement(value.node.body);
  if (
    !call ||
    !ts.isPropertyAccessExpression(unwrap(call.expression)) ||
    (unwrap(call.expression) as ts.PropertyAccessExpression).name.text !== "setLocalGcEnabled"
  )
    return undefined;
  const argument = call.arguments[0];
  return argument &&
    ts.isIdentifier(argument) &&
    value.source.bindings.lookup(argument)?.declaration === binding
    ? (unwrap(call.expression) as ts.PropertyAccessExpression).expression
    : undefined;
}

function classForInstance(
  source: Source,
  expression: ts.Expression,
): ts.ClassLikeDeclaration | undefined {
  expression = unwrap(expression);
  if (!ts.isIdentifier(expression)) return undefined;
  const binding = source.bindings.lookup(expression)?.declaration;
  if (!binding || !ts.isVariableDeclaration(binding.parent) || !binding.parent.initializer)
    return undefined;
  const value = unwrap(binding.parent.initializer);
  if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression)) return undefined;
  return classForName(source, value.expression);
}

function singletonGcPath(
  pkg: ClaudePinnedSources,
  source: Source,
  receiver: ts.Expression,
): RetentionPath | undefined {
  receiver = unwrap(receiver);
  if (!ts.isCallExpression(receiver) || receiver.arguments.length !== 0) return undefined;
  const accessor = pkg.functionValue(source, receiver.expression);
  if (
    !accessor ||
    !isFunction(accessor.node) ||
    !ts.isBlock(accessor.node.body) ||
    accessor.node.body.statements.length !== 1
  )
    return undefined;
  source = accessor.source;
  const returned = accessor.node.body.statements[0];
  const current =
    returned && ts.isReturnStatement(returned) && returned.expression
      ? unwrap(returned.expression)
      : undefined;
  if (
    !current ||
    !ts.isPropertyAccessExpression(current) ||
    current.name.text !== "current" ||
    !ts.isCallExpression(current.expression)
  )
    return undefined;
  const lookup = unwrap(current.expression.expression);
  if (!ts.isPropertyAccessExpression(lookup) || lookup.name.text !== "of") return undefined;
  const cell = pkg.value(source, lookup.expression);
  if (!cell || !ts.isNewExpression(cell.node) || cell.source !== source) return undefined;
  const factory = cell.node.arguments?.[0];
  if (!factory || !isFunction(factory) || !ts.isExpression(factory.body)) return undefined;
  const object = unwrap(factory.body);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const member = object.properties.find((item) => propertyName(item.name) === "current");
  const initial =
    member && ts.isPropertyAssignment(member) ? unwrap(member.initializer) : undefined;
  if (!initial || !ts.isNewExpression(initial) || !ts.isIdentifier(initial.expression))
    return undefined;
  const setterClass = classForName(source, initial.expression);
  if (!setterClass) return undefined;

  for (const statement of source.file.statements) {
    if (
      !ts.isFunctionDeclaration(statement) ||
      !statement.body ||
      statement.body.statements.length !== 3
    )
      continue;
    const [declaration, guard, result] = statement.body.statements;
    if (
      !declaration ||
      !ts.isVariableStatement(declaration) ||
      declaration.declarationList.declarations.length !== 1 ||
      !guard ||
      !ts.isIfStatement(guard) ||
      guard.elseStatement ||
      !result ||
      !ts.isReturnStatement(result)
    )
      continue;
    const local = declaration.declarationList.declarations[0]!;
    if (
      !ts.isIdentifier(local.name) ||
      !local.initializer ||
      !ts.isCallExpression(local.initializer)
    )
      continue;
    const owner = pkg.functionValue(source, local.initializer.expression);
    if (owner?.node !== accessor.node || owner.source !== source) continue;
    const binding = source.bindings.lookup(local.name)?.declaration;
    const isProject = (expression: ts.Expression | undefined) => {
      if (!expression) return false;
      expression = unwrap(expression);
      return (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "project" &&
        ts.isIdentifier(expression.expression) &&
        source.bindings.lookup(expression.expression)?.declaration === binding
      );
    };
    const condition = unwrap(guard.expression);
    if (
      !ts.isPrefixUnaryExpression(condition) ||
      condition.operator !== ts.SyntaxKind.ExclamationToken ||
      !isProject(condition.operand) ||
      !isProject(result.expression) ||
      !ts.isBlock(guard.thenStatement)
    )
      continue;
    const first = guard.thenStatement.statements[0];
    let assignment =
      first &&
      (ts.isIfStatement(first)
        ? first.expression
        : ts.isExpressionStatement(first)
          ? first.expression
          : undefined);
    while (
      assignment &&
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
      assignment = assignment.left;
    if (
      !assignment ||
      !ts.isBinaryExpression(assignment) ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !isProject(assignment.left)
    )
      continue;
    const created = unwrap(assignment.right);
    const argument = ts.isNewExpression(created) ? created.arguments?.[0] : undefined;
    if (
      !ts.isNewExpression(created) ||
      !ts.isIdentifier(created.expression) ||
      !argument ||
      !ts.isIdentifier(argument) ||
      source.bindings.lookup(argument)?.declaration !== binding
    )
      continue;
    const requestClass = classForName(source, created.expression);
    if (requestClass && constructorStoresStore(requestClass))
      return { source, setterClass, requestClass };
  }
  return undefined;
}

function classForName(source: Source, name: ts.Identifier): ts.ClassLikeDeclaration | undefined {
  const declaration = source.bindings.lookup(name)?.declaration;
  return declaration && ts.isClassDeclaration(declaration.parent) ? declaration.parent : undefined;
}

function hasLocalGcSetter(classDeclaration: ts.ClassLikeDeclaration, source: Source): boolean {
  const setter = classDeclaration.members.find(
    (member) => ts.isMethodDeclaration(member) && propertyName(member.name) === "setLocalGcEnabled",
  );
  if (!setter || !isFunction(setter) || !ts.isBlock(setter.body)) return false;
  const parameter = setter.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return false;
  const parameterBinding = source.bindings.lookup(parameter)?.declaration;
  const statement = setter.body.statements[0];
  if (
    !parameterBinding ||
    setter.body.statements.length !== 1 ||
    !statement ||
    !ts.isExpressionStatement(statement) ||
    !ts.isBinaryExpression(statement.expression)
  )
    return false;
  const assignment = statement.expression;
  const left = unwrap(assignment.left);
  const right = unwrap(assignment.right);
  return (
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(left) &&
    left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    left.name.text === "localGcEnabled" &&
    ts.isIdentifier(right) &&
    source.bindings.lookup(right)?.declaration === parameterBinding
  );
}

function hasRequestCompactGate(classDeclaration: ts.ClassLikeDeclaration, source: Source): boolean {
  const method = classDeclaration.members.find(
    (member) => ts.isMethodDeclaration(member) && propertyName(member.name) === "requestCompact",
  );
  if (!method || !isFunction(method) || !ts.isBlock(method.body)) return false;
  const guard = method.body.statements[0];
  if (
    !guard ||
    method.body.statements.length < 2 ||
    !ts.isIfStatement(guard) ||
    guard.elseStatement ||
    !returnsWhenGcDisabled(source, guard)
  )
    return false;
  let compactionCall = false;
  for (const statement of method.body.statements.slice(1)) {
    let unsupported = false;
    walkWithoutNestedFunctions(statement, (node) => {
      if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node))
        unsupported = true;
      if (
        ts.isCallExpression(node) &&
        ["enqueueCompact", "performCompactTranscript"].includes(callName(node.expression) ?? "")
      )
        compactionCall = true;
    });
    if (unsupported) return false;
  }
  return compactionCall;
}

function constructorStoresStore(classDeclaration: ts.ClassLikeDeclaration): boolean {
  const constructor = classDeclaration.members.find(ts.isConstructorDeclaration);
  const parameter = constructor?.parameters[0]?.name;
  if (!constructor?.body || !parameter || !ts.isIdentifier(parameter)) return false;
  const sourceFile = constructor.getSourceFile();
  const bindings = new ScopedBindings<never>(sourceFile);
  const parameterBinding = bindings.lookup(parameter)?.declaration;
  if (!parameterBinding) return false;
  let stores = false;
  walkWithoutNestedFunctions(constructor.body, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(unwrap(node.right)) ||
      bindings.lookup(unwrap(node.right) as ts.Identifier)?.declaration !== parameterBinding
    )
      return;
    const left = unwrap(node.left);
    if (
      ts.isPropertyAccessExpression(left) &&
      left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      left.name.text === "store"
    )
      stores = true;
  });
  return stores;
}

function singleCallStatement(node: ts.Statement | ts.ConciseBody): ts.CallExpression | undefined {
  if (ts.isBlock(node)) {
    if (node.statements.length !== 1) return undefined;
    const statement = node.statements[0];
    if (
      !statement ||
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      return undefined;
    return statement.expression;
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression))
    return node.expression;
  return ts.isCallExpression(node) ? node : undefined;
}

function returnsWhenGcDisabled(source: Source, statement: ts.IfStatement): boolean {
  const condition = unwrap(statement.expression);
  return (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken &&
    isLocalGcRead(condition.operand) &&
    statement.thenStatement.kind === ts.SyntaxKind.ReturnStatement
  );
}

function isLocalGcRead(expression: ts.Expression): boolean {
  expression = unwrap(expression);
  if (
    !(ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) ||
    property(expression) !== "localGcEnabled"
  )
    return false;
  const receiver = unwrap(expression.expression);
  return (
    receiver.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isPropertyAccessExpression(receiver) &&
      receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
      receiver.name.text === "store")
  );
}

function importOf(
  source: Source,
  identifier: ts.Identifier,
): { readonly specifier: string; readonly name: string } | undefined {
  let current: ts.Node = identifier;
  while (current.parent && !ts.isImportDeclaration(current.parent)) current = current.parent;
  const declaration = current.parent;
  if (
    !declaration ||
    !ts.isImportDeclaration(declaration) ||
    !ts.isStringLiteralLike(declaration.moduleSpecifier) ||
    !declaration.importClause
  )
    return undefined;
  const clause = declaration.importClause;
  if (clause.name === identifier)
    return { specifier: declaration.moduleSpecifier.text, name: "default" };
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    const item = clause.namedBindings.elements.find((entry) => entry.name === identifier);
    if (item)
      return {
        specifier: declaration.moduleSpecifier.text,
        name: (item.propertyName ?? item.name).text,
      };
  }
  return undefined;
}

function callName(node: ts.Expression): string | undefined {
  node = unwrap(node);
  return ts.isIdentifier(node)
    ? node.text
    : ts.isPropertyAccessExpression(node)
      ? node.name.text
      : undefined;
}

function isTrue(node: ts.Expression): boolean {
  node = unwrap(node);
  return (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    (ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isNumericLiteral(node.operand) &&
      Number(node.operand.text) === 0)
  );
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

function isProcessEnvRead(source: Source, node: ts.Node, key: ts.Identifier): boolean {
  return (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "env" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    source.bindings.lookup(node.expression.expression) === undefined &&
    node.argumentExpression &&
    ts.isIdentifier(node.argumentExpression) &&
    source.bindings.lookup(node.argumentExpression)?.declaration === key
  );
}

function isUndefined(source: Source, expression: ts.Expression): boolean {
  expression = unwrap(expression);
  return (
    (ts.isIdentifier(expression) &&
      expression.text === "undefined" &&
      source.bindings.lookup(expression) === undefined) ||
    (ts.isVoidExpression(expression) &&
      ts.isNumericLiteral(unwrap(expression.expression)) &&
      Number(unwrap(expression.expression).getText(source.file)) === 0)
  );
}

function property(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

export function staticProperty(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text
    : undefined;
}

export function propertyName(
  node: ts.PropertyName | ts.Expression | undefined,
): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return node.text;
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrap(node.expression);
    return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
      ? expression.text
      : undefined;
  }
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
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

function literalNumber(expression: ts.Expression): number | undefined {
  expression = unwrap(expression);
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.MinusToken ||
      expression.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(expression.operand)
  )
    return (
      (expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * Number(expression.operand.text)
    );
  return undefined;
}

function isFunction(node: ts.Node): node is FunctionWithBody {
  return ts.isFunctionLike(node) && "body" in node && !!node.body;
}

function matchesFunctionBody(value: Value, template: string): boolean {
  if (!isFunction(value.node)) return false;
  const file = ts.createSourceFile(
    "shape.js",
    template,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const node = file.statements.at(-1);
  if (!node || !isFunction(node) || node.parameters.length !== value.node.parameters.length)
    return false;
  const expected: Source = {
    name: "shape.js",
    text: template,
    file,
    bindings: new ScopedBindings<never>(file),
  };
  const shape = (source: Source, fn: FunctionWithBody) => {
    const names = new Map<ts.Identifier, number>();
    for (const parameter of fn.parameters) {
      if (!ts.isIdentifier(parameter.name)) return undefined;
      const binding = source.bindings.lookup(parameter.name)?.declaration;
      if (!binding) return undefined;
      names.set(binding, names.size);
    }
    const visit = (node: ts.Node): string => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isProperty =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        const binding = isProperty ? undefined : source.bindings.lookup(node)?.declaration;
        if (!binding) return `id:${node.text}`;
        if (!names.has(binding)) names.set(binding, names.size);
        return `binding:${names.get(binding)}`;
      }
      if (ts.isStringLiteralLike(node)) return `string:${JSON.stringify(node.text)}`;
      if (ts.isNumericLiteral(node)) return `number:${Number(node.text)}`;
      const children: string[] = [];
      ts.forEachChild(node, (child) => {
        children.push(visit(child));
      });
      return `${node.kind}[${children.join(",")}]`;
    };
    return visit(fn.body);
  };
  return shape(value.source, value.node) === shape(expected, node);
}

function isGlobalObjectCall(source: Source, expression: ts.Expression, name: string): boolean {
  expression = unwrap(expression);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === name &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Object" &&
    source.bindings.lookup(expression.expression) === undefined
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function walkWithoutNestedFunctions(node: ts.Node, visit: (node: ts.Node) => void): void {
  const visitChild = (child: ts.Node): void => {
    visit(child);
    ts.forEachChild(child, (grandchild) => {
      if (!ts.isFunctionLike(grandchild)) visitChild(grandchild);
    });
  };
  visitChild(node);
}
