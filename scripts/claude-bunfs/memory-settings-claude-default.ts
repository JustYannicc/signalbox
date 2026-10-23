import ts from "typescript-legacy";
import {
  ClaudeSourceGraph,
  functionWithBody,
  propertyName,
  staticProperty,
  unwrap,
} from "./memory-settings-claude-graph.ts";
import type { ClaudeFunctionWithBody, ClaudeParsedSource } from "./memory-settings-claude-graph.ts";
import { ClaudeEnvironmentOrigin } from "./memory-settings-claude-environment.ts";
import type { SettingReadConstraint } from "./memory-settings-claude-environment.ts";

export interface ClaudeSettingRead {
  readonly key: string;
  readonly source: ClaudeParsedSource;
  readonly node: ts.Expression;
  readonly constraint: SettingReadConstraint;
}

export interface ClaudeSettingEvidence {
  readonly key: string;
  readonly source: string;
  readonly default: string | undefined;
  readonly changed: boolean;
}

interface DefaultObservation {
  readonly value: number;
  readonly changed: boolean;
}

function visitWithoutNestedFunctions(node: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (child: ts.Node): void => {
    visit(child);
    ts.forEachChild(child, (grandchild) => {
      if (!ts.isFunctionLike(grandchild)) walk(grandchild);
    });
  };
  walk(node);
}

function isUndefined(source: ClaudeParsedSource, expression: ts.Expression): boolean {
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

function parameterMatches(
  source: ClaudeParsedSource,
  expression: ts.Expression | undefined,
  parameter: ts.ParameterDeclaration,
): boolean {
  return (
    !!expression &&
    ts.isIdentifier(expression) &&
    ts.isIdentifier(parameter.name) &&
    source.bindings.lookup(expression)?.declaration ===
      source.bindings.lookup(parameter.name)?.declaration
  );
}

/** Interprets only the numeric and missing-value paths needed to prove a native default. */
export class ClaudeDefaultEvaluator {
  private readonly graph: ClaudeSourceGraph;
  private readonly environment: ClaudeEnvironmentOrigin;

  constructor(graph: ClaudeSourceGraph, environment: ClaudeEnvironmentOrigin) {
    this.graph = graph;
    this.environment = environment;
  }

  inspect(pins: Readonly<Record<string, string>>): ClaudeSettingEvidence[] {
    const keys = new Set(Object.keys(pins));
    const candidateNames = [...this.graph.names()].filter((name) => {
      const text = this.graph.text(name);
      return text !== undefined && [...keys].some((key) => text.includes(key));
    });
    const reads = candidateNames.flatMap((name) => {
      const source = this.graph.source(name);
      return source ? this.readNodes(source, keys, pins) : [];
    });

    return [...keys].map((key) => {
      const matching = reads.filter((read) => read.key === key);
      if (matching.length === 0) return { key, source: "", default: undefined, changed: false };
      const pin = Number(pins[key]);
      const observations = matching.map((read) => this.calledDefault(read, pin));
      const values = observations.map((value) => value?.value);
      const proven = new Set(values.filter((value): value is number => value !== undefined));
      const nativeDefault =
        proven.size === 1 && values.every((value) => value !== undefined)
          ? String([...proven][0])
          : undefined;
      const changed =
        matching.some((read) => read.constraint === "changed") ||
        observations.some((value) => value?.changed === true);
      return { key, source: matching[0]!.source.name, default: nativeDefault, changed };
    });
  }

  private readNodes(
    source: ClaudeParsedSource,
    keys: ReadonlySet<string>,
    pins: Readonly<Record<string, string>>,
  ): ClaudeSettingRead[] {
    const reads: ClaudeSettingRead[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const key = staticProperty(node);
        if (key && keys.has(key)) {
          const origin = this.environment.settingRead(source, node, key, Number(pins[key]));
          if (origin.recognized) reads.push({ key, source, node, constraint: origin.constraint });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.file);
    return reads;
  }

  private numericValue(
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
      const value = this.numericValue(source, expression.operand, seen);
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
    return this.numericValue(values[0]!.source, values[0]!.node as ts.Expression, seen);
  }

  private missingValueBranch(
    source: ClaudeParsedSource,
    expression: ts.Expression,
    parameter: ts.ParameterDeclaration,
  ): "then" | "else" | undefined {
    expression = unwrap(expression);
    if (
      ts.isPrefixUnaryExpression(expression) &&
      expression.operator === ts.SyntaxKind.ExclamationToken &&
      parameterMatches(source, expression.operand, parameter)
    )
      return "then";
    if (!ts.isBinaryExpression(expression)) return undefined;

    const operator = expression.operatorToken.kind;
    const equality =
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const inequality =
      operator === ts.SyntaxKind.ExclamationEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (!equality && !inequality) return undefined;

    const left = unwrap(expression.left);
    const right = unwrap(expression.right);
    const tested = isUndefined(source, left)
      ? expression.right
      : isUndefined(source, right)
        ? expression.left
        : left.kind === ts.SyntaxKind.NullKeyword
          ? expression.right
          : right.kind === ts.SyntaxKind.NullKeyword
            ? expression.left
            : undefined;
    if (!tested || !parameterMatches(source, tested, parameter)) return undefined;
    return equality ? "then" : "else";
  }

  private returnUsesParameter(
    source: ClaudeParsedSource,
    statement: ts.Statement,
    parameter: ts.ParameterDeclaration,
  ): boolean {
    let found = false;
    visitWithoutNestedFunctions(statement, (node) => {
      if (!ts.isReturnStatement(node) || !node.expression) return;
      const expression = unwrap(node.expression);
      if (!ts.isObjectLiteralExpression(expression)) return;
      for (const property of expression.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "effective" &&
          parameterMatches(source, property.initializer, parameter)
        )
          found = true;
      }
    });
    return found;
  }

  private parserFallback(read: ClaudeSettingRead, pin: number): DefaultObservation | undefined {
    const call = read.node.parent;
    if (!call || !ts.isCallExpression(call)) return undefined;
    const valueArgument = call.arguments.findIndex((argument) => unwrap(argument) === read.node);
    if (valueArgument !== 1 || call.arguments.length < 3) return undefined;
    const keyArgument = call.arguments[0] && unwrap(call.arguments[0]);
    if (!keyArgument || !ts.isStringLiteralLike(keyArgument) || keyArgument.text !== read.key)
      return undefined;

    const valid = this.graph.functionValues(read.source, call.expression).some((value) => {
      if (!functionWithBody(value.node)) return false;
      const valueParameter = value.node.parameters[1];
      const defaultParameter = value.node.parameters[2];
      if (!valueParameter || !defaultParameter) return false;
      let provesDefault = false;
      visitWithoutNestedFunctions(value.node.body, (node) => {
        if (!ts.isIfStatement(node)) return;
        const missingBranch = this.missingValueBranch(
          value.source,
          node.expression,
          valueParameter,
        );
        const branch = missingBranch === "then" ? node.thenStatement : node.elseStatement;
        if (branch && this.returnUsesParameter(value.source, branch, defaultParameter))
          provesDefault = true;
      });
      return provesDefault;
    });
    if (!valid) return undefined;
    const value = this.numericValue(read.source, call.arguments[2]!);
    if (value === undefined) return undefined;
    const upperArgument = call.arguments[3];
    const upperBound = upperArgument ? this.numericValue(read.source, upperArgument) : undefined;
    if (call.arguments.length > 3 && upperBound === undefined) return undefined;
    return { value, changed: upperBound !== undefined && upperBound < pin };
  }

  private readValueBinding(read: ClaudeSettingRead): ts.Identifier | undefined {
    const declaration = read.node.parent;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      unwrap(declaration.initializer) === read.node &&
      ts.isIdentifier(declaration.name)
    )
      return read.source.bindings.lookup(declaration.name)?.declaration;
    return undefined;
  }

  private functionReturnsRead(read: ClaudeSettingRead, fn: ClaudeFunctionWithBody): boolean {
    const valueBinding = this.readValueBinding(read);
    if (!valueBinding || !fn.body) return false;
    const value = this.graph.declarationValues(read.source, valueBinding);
    if (value.length !== 1 || unwrap(value[0]!.node as ts.Expression) !== read.node) return false;
    let returnsRead = false;
    let hasUnsupportedReturn = false;

    visitWithoutNestedFunctions(fn.body, (node) => {
      if (!ts.isReturnStatement(node) || !node.expression) return;
      const expression = unwrap(node.expression);
      if (
        ts.isIdentifier(expression) &&
        read.source.bindings.lookup(expression)?.declaration === valueBinding
      ) {
        returnsRead = true;
        return;
      }
      if (ts.isVoidExpression(expression) || isUndefined(read.source, expression)) return;
      hasUnsupportedReturn = true;
    });
    return returnsRead && !hasUnsupportedReturn;
  }

  private directFallback(read: ClaudeSettingRead): number | undefined {
    let value: ts.Expression = read.node;
    let parent = value.parent;
    while (parent && ts.isCallExpression(parent)) {
      const callee = unwrap(parent.expression);
      if (
        !ts.isIdentifier(callee) ||
        callee.text !== "Number" ||
        read.source.bindings.lookup(callee) !== undefined ||
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
    )
      return this.numericValue(read.source, parent.right);
    return undefined;
  }

  private calledDefault(read: ClaudeSettingRead, pin: number): DefaultObservation | undefined {
    if (read.constraint !== "proven") return undefined;
    const direct = this.directFallback(read);
    if (direct !== undefined) return { value: direct, changed: false };
    const parser = this.parserFallback(read, pin);
    if (parser !== undefined) return parser;

    let owner: ClaudeFunctionWithBody | undefined;
    for (let node: ts.Node | undefined = read.node.parent; node; node = node.parent) {
      if (functionWithBody(node)) {
        owner = node;
        break;
      }
    }
    if (!owner || !this.functionReturnsRead(read, owner)) return undefined;

    const candidateNames = new Set([read.source.name]);
    for (const name of this.graph.names()) {
      if (this.graph.text(name)?.includes(read.key)) candidateNames.add(name);
    }
    const fallbacks: Array<number | undefined> = [];
    for (const name of candidateNames) {
      const source = this.graph.source(name);
      if (!source) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          const call = unwrap(node.left);
          if (ts.isCallExpression(call)) {
            const targets = this.graph.functionValues(source, call.expression);
            if (targets.some((target) => target.source === read.source && target.node === owner))
              fallbacks.push(this.numericValue(source, node.right));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source.file);
    }
    if (fallbacks.length === 0 || fallbacks.some((value) => value === undefined)) return undefined;
    const values = new Set(fallbacks as number[]);
    return values.size === 1 ? { value: [...values][0]!, changed: false } : undefined;
  }
}
