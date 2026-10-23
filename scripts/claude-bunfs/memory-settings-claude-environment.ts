import ts from "typescript-legacy";
import { processRequireOrigin } from "./pinned-environment-origin.ts";
import {
  ClaudeSourceGraph,
  firstBindingIdentifier,
  functionWithBody,
  isWrite,
  propertyName,
  staticProperty,
  unwrap,
  variableDeclarationForBinding,
} from "./memory-settings-claude-graph.ts";
import type {
  ClaudeFunctionWithBody,
  ClaudeParsedSource,
  ClaudeValueRef,
} from "./memory-settings-claude-graph.ts";

type EnvironmentOrigin =
  | { readonly kind: "native" }
  | {
      readonly kind: "registry";
      readonly descriptors: ReadonlyMap<string, ClaudeValueRef | undefined>;
    };

interface SourceHelpers {
  readonly proxyBuilders: Set<ClaudeFunctionWithBody>;
  readonly exportedValues: Map<ts.Identifier, Map<string, ClaudeValueRef | undefined>>;
}

export type SettingReadConstraint = "proven" | "unproven" | "changed";

export interface SettingReadOrigin {
  readonly recognized: boolean;
  readonly constraint: SettingReadConstraint;
}

function visitWithoutNestedFunctions(node: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (child: ts.Node): void => {
    visit(child);
    ts.forEachChild(child, (grandchild) => {
      if (ts.isFunctionLike(grandchild)) return;
      walk(grandchild);
    });
  };
  walk(node);
}

function sourceFunction(node: ts.Node): node is ClaudeFunctionWithBody {
  return functionWithBody(node);
}

function bindingPathFor(
  declaration: ts.Identifier,
  variable: ts.VariableDeclaration,
): ReadonlyArray<string> | undefined {
  if (ts.isIdentifier(variable.name)) return [];
  const path: string[] = [];
  let current: ts.Node = declaration;
  while (current !== variable.name) {
    const parent = current.parent;
    if (ts.isBindingElement(parent)) {
      if (parent.dotDotDotToken) return undefined;
      const key = parent.propertyName
        ? propertyName(parent.propertyName)
        : ts.isIdentifier(parent.name)
          ? parent.name.text
          : undefined;
      if (!key) return undefined;
      path.unshift(key);
      current = parent;
      continue;
    }
    if (ts.isObjectBindingPattern(parent) || ts.isArrayBindingPattern(parent)) {
      current = parent;
      continue;
    }
    return undefined;
  }
  return path;
}

/** Proves whether a property read comes from Node's process.env or a typed env registry. */
export class ClaudeEnvironmentOrigin {
  private readonly helpers = new WeakMap<ClaudeParsedSource, SourceHelpers>();
  private readonly graph: ClaudeSourceGraph;

  constructor(graph: ClaudeSourceGraph) {
    this.graph = graph;
  }

  settingRead(
    source: ClaudeParsedSource,
    node: ts.Expression,
    key: string,
    pin: number,
  ): SettingReadOrigin {
    node = unwrap(node);
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
      return { recognized: false, constraint: "unproven" };
    if (staticProperty(node) !== key || isWrite(node))
      return { recognized: false, constraint: "unproven" };
    const origin = this.environmentOrigin(source, node.expression);
    if (origin?.kind === "native") return { recognized: true, constraint: "proven" };
    if (origin?.kind !== "registry") return { recognized: false, constraint: "unproven" };
    if (!origin.descriptors.has(key)) return { recognized: false, constraint: "unproven" };
    const descriptor = origin.descriptors.get(key);
    if (!descriptor) return { recognized: true, constraint: "unproven" };
    return { recognized: true, constraint: this.integerDescriptor(descriptor, pin) };
  }

  private helperState(source: ClaudeParsedSource): SourceHelpers {
    const existing = this.helpers.get(source);
    if (existing) return existing;
    const created: SourceHelpers = {
      proxyBuilders: new Set(),
      exportedValues: new Map(),
    };
    this.helpers.set(source, created);
    this.indexHelpers(source, created);
    return created;
  }

  private staticNumber(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    seen = new Set<string>(),
  ): number | undefined {
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
      const value = this.staticNumber(source, expression.operand, seen);
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
    const values = this.graph.declarationValues(source, declaration);
    if (values.length !== 1) return undefined;
    return this.staticNumber(values[0]!.source, values[0]!.node as ts.Expression, seen);
  }

  private resolveDescriptorValue(
    source: ClaudeParsedSource,
    expression: ts.Expression | ClaudeFunctionWithBody,
    seen = new Set<string>(),
  ): ClaudeValueRef | undefined {
    if (functionWithBody(expression)) {
      if (expression.parameters.length !== 0) return undefined;
      if (ts.isExpression(expression.body))
        return this.resolveDescriptorValue(source, expression.body, seen);
      if (expression.body.statements.length !== 1) return undefined;
      const statement = expression.body.statements[0];
      if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return undefined;
      return this.resolveDescriptorValue(source, statement.expression, seen);
    }
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) {
      const declaration = source.bindings.lookup(expression)?.declaration;
      if (!declaration) return undefined;
      const token = `${source.name}\0${declaration.pos}`;
      if (seen.has(token)) return undefined;
      seen.add(token);
      const values = this.graph.declarationValues(source, declaration);
      if (values.length !== 1) return undefined;
      return this.resolveDescriptorValue(values[0]!.source, values[0]!.node, seen);
    }
    return { source, node: expression };
  }

  private integerDescriptor(value: ClaudeValueRef, pin: number): SettingReadConstraint {
    const resolved = this.resolveDescriptorValue(value.source, value.node);
    if (!resolved || !ts.isCallExpression(resolved.node)) return "unproven";
    const callee = unwrap(resolved.node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "int") return "unproven";
    if (resolved.node.arguments.length > 1) return "unproven";

    let minimum = Number.NEGATIVE_INFINITY;
    let maximum = Number.POSITIVE_INFINITY;
    const options = resolved.node.arguments[0];
    if (options) {
      const object = unwrap(options);
      if (!ts.isObjectLiteralExpression(object)) return "unproven";
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) return "unproven";
        const name = propertyName(property.name);
        const value = this.staticNumber(resolved.source, property.initializer);
        if (value === undefined) return "unproven";
        if (name === "min") minimum = value;
        else if (name === "max") maximum = value;
        else return "unproven";
      }
    }
    if (pin < minimum || pin > maximum) return "changed";
    return "proven";
  }

  private importKind(
    source: ClaudeParsedSource,
    declaration: ts.Identifier,
  ): "process" | "environment" | undefined {
    const imported = this.graph.importDeclaration(source, declaration);
    if (
      !imported ||
      !ts.isStringLiteralLike(imported.moduleSpecifier) ||
      !["process", "node:process"].includes(imported.moduleSpecifier.text)
    )
      return undefined;
    const name = this.graph.importedName(imported, declaration);
    if (name === "env") return "environment";
    if (name === "*" || name === "default" || name === "process") return "process";
    return undefined;
  }

  private isProcess(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean {
    expression = unwrap(expression);
    if (ts.isCallExpression(expression)) {
      const origin = processRequireOrigin(expression, source.bindings);
      return origin?.length === 0;
    }
    if (!ts.isIdentifier(expression)) return false;
    if (expression.text === "process" && source.bindings.lookup(expression) === undefined)
      return true;
    const declaration = source.bindings.lookup(expression)?.declaration;
    if (!declaration) return false;
    const imported = this.importKind(source, declaration);
    if (imported) return imported === "process";
    if (this.graph.importDeclaration(source, declaration)) return false;
    const variable = variableDeclarationForBinding(declaration);
    if (
      variable?.initializer &&
      bindingPathFor(declaration, variable)?.join(".") === "process" &&
      this.isProcess(source, variable.initializer, seen)
    )
      return true;
    const token = `${source.name}\0${declaration.pos}`;
    if (seen.has(token)) return false;
    seen.add(token);
    return this.graph
      .declarationValues(source, declaration)
      .some((value) => this.isProcess(value.source, value.node as ts.Expression, seen));
  }

  private environmentOrigin(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    seen = new Set<string>(),
  ): EnvironmentOrigin | undefined {
    expression = unwrap(expression);
    if (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      staticProperty(expression) === "env" &&
      this.isProcess(source, expression.expression)
    )
      return { kind: "native" };
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration = source.bindings.lookup(expression)?.declaration;
    if (!declaration) return undefined;
    const token = `${source.name}\0${declaration.pos}`;
    if (seen.has(token)) return undefined;
    seen.add(token);

    const imported = this.importKind(source, declaration);
    if (imported === "environment") return { kind: "native" };

    const parent = variableDeclarationForBinding(declaration);
    if (
      parent &&
      parent.initializer &&
      bindingPathFor(declaration, parent)?.join(".") === "env" &&
      this.isProcess(source, parent.initializer)
    )
      return { kind: "native" };

    for (const value of this.graph.declarationValues(source, declaration)) {
      const node = unwrap(value.node as ts.Expression);
      const isBuilder =
        ts.isCallExpression(node) && this.isRegistryBuilder(value.source, node.expression);
      if (ts.isCallExpression(node) && isBuilder) {
        const registry = node.arguments[0];
        const descriptors = registry
          ? this.registeredDescriptors(value.source, registry)
          : new Map<string, ClaudeValueRef | undefined>();
        return {
          kind: "registry",
          descriptors,
        };
      }
      const nested = this.environmentOrigin(value.source, node, seen);
      if (nested) return nested;
    }
    return undefined;
  }

  private isNativeEnvironment(source: ClaudeParsedSource, expression: ts.Expression): boolean {
    return this.environmentOrigin(source, expression)?.kind === "native";
  }

  private dynamicEnvironmentGetter(
    source: ClaudeParsedSource,
    fn: ClaudeFunctionWithBody,
  ): boolean {
    const parameter = fn.parameters[0]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) return false;
    const parameterBinding = source.bindings.lookup(parameter)?.declaration;
    if (!parameterBinding || !fn.body) return false;

    const readsParameter = (body: ts.Node) => {
      let found = false;
      const walk = (node: ts.Node): void => {
        if (
          ts.isElementAccessExpression(node) &&
          !isWrite(node) &&
          this.isNativeEnvironment(source, node.expression) &&
          node.argumentExpression &&
          ts.isIdentifier(node.argumentExpression) &&
          source.bindings.lookup(node.argumentExpression)?.declaration === parameterBinding
        ) {
          found = true;
          return;
        }
        ts.forEachChild(node, (child) => {
          if (!ts.isFunctionLike(child)) walk(child);
        });
      };
      walk(body);
      return found;
    };

    if (ts.isExpression(fn.body)) {
      const returned = unwrap(fn.body);
      if (functionWithBody(returned)) return readsParameter(returned.body);
    }
    let found = false;
    visitWithoutNestedFunctions(fn.body, (node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        const returned = unwrap(node.expression);
        if (functionWithBody(returned) && readsParameter(returned.body)) found = true;
      }
    });
    return found || readsParameter(fn.body);
  }

  private objectEntriesRegistry(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    registryBinding: ts.Identifier,
  ): ts.Expression | undefined {
    expression = unwrap(expression);
    if (ts.isCallExpression(expression)) {
      const registry = expression.arguments[0];
      return this.graph.isGlobalObjectMember(source, expression.expression, "entries") &&
        registry &&
        ts.isIdentifier(registry) &&
        source.bindings.lookup(registry)?.declaration === registryBinding
        ? registry
        : undefined;
    }
    if (!ts.isConditionalExpression(expression)) return undefined;
    const branches = [unwrap(expression.whenTrue), unwrap(expression.whenFalse)];
    const empty = branches.some(
      (branch) => ts.isArrayLiteralExpression(branch) && branch.elements.length === 0,
    );
    if (!empty) return undefined;
    const populated = branches.find((branch): branch is ts.CallExpression => {
      if (!ts.isCallExpression(branch)) return false;
      const registry = branch.arguments[0];
      return (
        this.graph.isGlobalObjectMember(source, branch.expression, "entries") &&
        !!registry &&
        ts.isIdentifier(registry) &&
        source.bindings.lookup(registry)?.declaration === registryBinding
      );
    });
    return populated?.arguments[0];
  }

  private proxyBuilder(source: ClaudeParsedSource, fn: ClaudeFunctionWithBody): boolean {
    const registryParam = fn.parameters[0]?.name;
    if (!registryParam || !ts.isIdentifier(registryParam) || !fn.body) return false;
    const registryBinding = source.bindings.lookup(registryParam)?.declaration;
    if (!registryBinding) return false;
    let valid = false;

    const visit = (node: ts.Node): void => {
      if (valid || !ts.isForOfStatement(node)) {
        if (!valid) ts.forEachChild(node, visit);
        return;
      }
      const initializer = node.initializer;
      const declaration =
        ts.isVariableDeclarationList(initializer) && initializer.declarations.length === 1
          ? initializer.declarations[0]
          : undefined;
      const key = declaration ? firstBindingIdentifier(declaration.name) : undefined;
      const descriptor =
        declaration && ts.isArrayBindingPattern(declaration.name)
          ? declaration.name.elements[1]
          : undefined;
      const descriptorIdentifier =
        descriptor && ts.isBindingElement(descriptor) && ts.isIdentifier(descriptor.name)
          ? descriptor.name
          : undefined;
      const keyBinding = key ? source.bindings.lookup(key)?.declaration : undefined;
      const descriptorBinding = descriptorIdentifier
        ? source.bindings.lookup(descriptorIdentifier)?.declaration
        : undefined;
      const registry = this.objectEntriesRegistry(source, node.expression, registryBinding);
      if (!key || !keyBinding || !descriptorBinding || !registry) {
        ts.forEachChild(node, visit);
        return;
      }

      let target: ts.Identifier | undefined;
      const inspect = (child: ts.Node): void => {
        if (valid) return;
        if (
          ts.isCallExpression(child) &&
          this.graph.isGlobalObjectMember(source, child.expression, "defineProperty")
        ) {
          const [object, property, descriptor] = child.arguments;
          const getter =
            descriptor && ts.isObjectLiteralExpression(descriptor)
              ? descriptor.properties.find(
                  (part) => propertyName(part.name) === "get" && ts.isPropertyAssignment(part),
                )
              : undefined;
          const value =
            getter && ts.isPropertyAssignment(getter) ? unwrap(getter.initializer) : undefined;
          if (
            object &&
            ts.isIdentifier(object) &&
            property &&
            ts.isIdentifier(property) &&
            source.bindings.lookup(property)?.declaration === keyBinding &&
            value &&
            ts.isCallExpression(value) &&
            value.arguments[0] &&
            ts.isIdentifier(value.arguments[0]) &&
            source.bindings.lookup(value.arguments[0])?.declaration === keyBinding &&
            value.arguments[1] &&
            ts.isIdentifier(value.arguments[1]) &&
            source.bindings.lookup(value.arguments[1])?.declaration === descriptorBinding &&
            this.graph
              .functionValues(source, value.expression)
              .some(
                (candidate) =>
                  sourceFunction(candidate.node) &&
                  this.dynamicEnvironmentGetter(candidate.source, candidate.node),
              )
          ) {
            target = object;
            valid = true;
          }
        }
        if (!valid) ts.forEachChild(child, inspect);
      };
      visitWithoutNestedFunctions(node.statement, inspect);
      if (!valid || !target) return;

      let returnsTarget = false;
      visitWithoutNestedFunctions(fn.body, (child) => {
        const returned =
          child && ts.isReturnStatement(child) && child.expression
            ? unwrap(child.expression)
            : undefined;
        const result =
          returned &&
          ts.isBinaryExpression(returned) &&
          returned.operatorToken.kind === ts.SyntaxKind.CommaToken
            ? unwrap(returned.right)
            : returned;
        if (
          ts.isReturnStatement(child) &&
          result &&
          ts.isIdentifier(result) &&
          source.bindings.lookup(result)?.declaration ===
            source.bindings.lookup(target!)?.declaration
        )
          returnsTarget = true;
      });
      valid = returnsTarget;
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return valid;
  }

  private isDefinePropertyWriter(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean {
    expression = unwrap(expression);
    if (this.graph.isGlobalObjectMember(source, expression, "defineProperty")) return true;
    if (!ts.isIdentifier(expression)) return false;
    const declaration = source.bindings.lookup(expression)?.declaration;
    if (!declaration) return false;
    const bindingParent = variableDeclarationForBinding(declaration);
    if (
      bindingParent &&
      bindingParent.initializer &&
      bindingPathFor(declaration, bindingParent)?.join(".") === "defineProperty"
    ) {
      const object = unwrap(bindingParent.initializer);
      if (
        ts.isIdentifier(object) &&
        object.text === "Object" &&
        source.bindings.lookup(object) === undefined
      )
        return true;
    }
    const token = `${source.name}\0${declaration.pos}`;
    if (seen.has(token)) return false;
    seen.add(token);
    return this.graph.declarationValues(source, declaration).some((value) => {
      const node = unwrap(value.node as ts.Expression);
      if (this.graph.isGlobalObjectMember(value.source, node, "defineProperty")) return true;
      if (!sourceFunction(node)) return false;
      const parameters = node.parameters.slice(0, 3).map((parameter) => parameter.name);
      if (!parameters.every(ts.isIdentifier)) return false;
      const bindings = parameters.map(
        (parameter) => value.source.bindings.lookup(parameter)?.declaration,
      );
      let found = false;
      visitWithoutNestedFunctions(node.body, (child) => {
        if (
          ts.isCallExpression(child) &&
          this.isDefinePropertyWriter(value.source, child.expression, seen)
        ) {
          const matches = child.arguments
            .slice(0, 3)
            .map(
              (argument, index) =>
                ts.isIdentifier(argument) &&
                value.source.bindings.lookup(argument)?.declaration === bindings[index],
            );
          if (matches.length === 3 && matches.every(Boolean)) found = true;
        }
      });
      return found;
    });
  }

  private exportPopulator(source: ClaudeParsedSource, fn: ClaudeFunctionWithBody): boolean {
    const targetParam = fn.parameters[0]?.name;
    const descriptorsParam = fn.parameters[1]?.name;
    if (
      !targetParam ||
      !descriptorsParam ||
      !ts.isIdentifier(targetParam) ||
      !ts.isIdentifier(descriptorsParam) ||
      !fn.body
    )
      return false;
    const targetBinding = source.bindings.lookup(targetParam)?.declaration;
    const descriptorsBinding = source.bindings.lookup(descriptorsParam)?.declaration;
    if (!targetBinding || !descriptorsBinding) return false;
    let valid = false;

    visitWithoutNestedFunctions(fn.body, (node) => {
      if (
        valid ||
        !ts.isForInStatement(node) ||
        !ts.isIdentifier(node.expression) ||
        source.bindings.lookup(node.expression)?.declaration !== descriptorsBinding
      )
        return;
      const key = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.length === 1
          ? node.initializer.declarations[0]?.name
          : undefined
        : node.initializer;
      if (!key || !ts.isIdentifier(key)) return;
      const keyBinding = source.bindings.lookup(key)?.declaration;
      visitWithoutNestedFunctions(node.statement, (child) => {
        if (
          valid ||
          !ts.isCallExpression(child) ||
          !this.isDefinePropertyWriter(source, child.expression)
        )
          return;
        const [target, property, descriptor] = child.arguments;
        const getter =
          descriptor && ts.isObjectLiteralExpression(descriptor)
            ? descriptor.properties.find(
                (part) => propertyName(part.name) === "get" && ts.isPropertyAssignment(part),
              )
            : undefined;
        const getterValue =
          getter && ts.isPropertyAssignment(getter) ? unwrap(getter.initializer) : undefined;
        if (
          target &&
          ts.isIdentifier(target) &&
          source.bindings.lookup(target)?.declaration === targetBinding &&
          property &&
          ts.isIdentifier(property) &&
          source.bindings.lookup(property)?.declaration === keyBinding &&
          getterValue &&
          ts.isElementAccessExpression(getterValue) &&
          ts.isIdentifier(getterValue.expression) &&
          source.bindings.lookup(getterValue.expression)?.declaration === descriptorsBinding &&
          getterValue.argumentExpression &&
          ts.isIdentifier(getterValue.argumentExpression) &&
          source.bindings.lookup(getterValue.argumentExpression)?.declaration === keyBinding
        )
          valid = true;
      });
    });
    return valid;
  }

  private indexHelpers(source: ClaudeParsedSource, state: SourceHelpers): void {
    for (const fn of source.functionNodes) {
      if (this.proxyBuilder(source, fn)) state.proxyBuilders.add(fn);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length >= 2) {
        const targetArgument = node.arguments[0];
        const descriptorArgument = node.arguments[1];
        if (!targetArgument || !descriptorArgument || !ts.isIdentifier(targetArgument)) {
          ts.forEachChild(node, visit);
          return;
        }
        const helpers = this.graph.functionValues(source, node.expression);
        if (
          helpers.some(
            (value) => sourceFunction(value.node) && this.exportPopulator(value.source, value.node),
          ) &&
          ts.isObjectLiteralExpression(descriptorArgument)
        ) {
          const target = source.bindings.lookup(targetArgument)?.declaration;
          if (target) {
            const values =
              state.exportedValues.get(target) ?? new Map<string, ClaudeValueRef | undefined>();
            for (const property of descriptorArgument.properties) {
              if (ts.isSpreadAssignment(property)) continue;
              const name = propertyName(property.name);
              const value = ts.isPropertyAssignment(property)
                ? property.initializer
                : ts.isShorthandPropertyAssignment(property)
                  ? property.name
                  : undefined;
              if (name) values.set(name, value ? { source, node: value } : undefined);
            }
            state.exportedValues.set(target, values);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.file);
  }

  private registeredDescriptors(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    seen = new Set<string>(),
  ): Map<string, ClaudeValueRef | undefined> {
    this.helperState(source);
    expression = unwrap(expression);
    const values = new Map<string, ClaudeValueRef | undefined>();
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const [key, value] of this.registeredDescriptors(source, property.expression, seen))
            values.set(key, value);
        } else {
          const key = propertyName(property.name);
          const value = ts.isPropertyAssignment(property)
            ? property.initializer
            : ts.isShorthandPropertyAssignment(property)
              ? property.name
              : undefined;
          if (key) values.set(key, value ? { source, node: value } : undefined);
        }
      }
    } else if (ts.isIdentifier(expression)) {
      const declaration = source.bindings.lookup(expression)?.declaration;
      if (!declaration) return values;
      const token = `${source.name}\0${declaration.pos}`;
      if (seen.has(token)) return values;
      seen.add(token);
      const state = this.helpers.get(source)!;
      for (const [key, value] of state.exportedValues.get(declaration) ?? [])
        values.set(key, value);
      for (const value of this.graph.declarationValues(source, declaration)) {
        if (value.declaration) {
          const valueState = this.helperState(value.source);
          for (const [key, descriptor] of valueState.exportedValues.get(value.declaration) ?? [])
            values.set(key, descriptor);
        }
        const nested = this.registeredDescriptors(value.source, value.node as ts.Expression, seen);
        for (const [key, descriptor] of nested) values.set(key, descriptor);
      }
    }
    return values;
  }

  private isRegistryBuilder(source: ClaudeParsedSource, expression: ts.Expression): boolean {
    return this.graph.functionValues(source, expression).some((value) => {
      if (!sourceFunction(value.node)) return false;
      const state = this.helperState(value.source);
      return state.proxyBuilders.has(value.node);
    });
  }
}
