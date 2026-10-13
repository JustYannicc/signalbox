import type { WorkflowDetailValue, WorkflowLabel } from "@t3tools/contracts";
import type { Node } from "oxc-parser";

import type { WorkflowSource } from "./source.ts";

const NOT_LITERAL = Symbol("not-literal");
const MAX_EXPRESSION_LENGTH = 300;

/** Strips wrappers that don't change a value: `as const`, `satisfies`, `!`, parentheses. */
export function unwrap(node: Node): Node {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Evaluates a pure literal (strings, numbers, booleans, null, and arrays or
 * objects of them). Returns `NOT_LITERAL` for anything that needs running code.
 */
function literalValue(input: Node): unknown {
  const node = unwrap(input);
  switch (node.type) {
    case "Literal":
      if ("regex" in node || "bigint" in node) return NOT_LITERAL;
      return node.value;
    case "TemplateLiteral":
      return node.expressions.length === 0
        ? (node.quasis[0]?.value.cooked ?? NOT_LITERAL)
        : NOT_LITERAL;
    case "UnaryExpression": {
      if (node.operator !== "-") return NOT_LITERAL;
      const value = literalValue(node.argument);
      return typeof value === "number" ? -value : NOT_LITERAL;
    }
    case "ArrayExpression": {
      const values: unknown[] = [];
      for (const element of node.elements) {
        if (element === null || element.type === "SpreadElement") return NOT_LITERAL;
        const value = literalValue(element);
        if (value === NOT_LITERAL) return NOT_LITERAL;
        values.push(value);
      }
      return values;
    }
    case "ObjectExpression": {
      const value: Record<string, unknown> = {};
      for (const property of node.properties) {
        const key = propertyKey(property);
        if (key === null || property.type !== "Property" || property.shorthand) return NOT_LITERAL;
        const entry = literalValue(property.value);
        if (entry === NOT_LITERAL) return NOT_LITERAL;
        value[key] = entry;
      }
      return value;
    }
    default:
      return NOT_LITERAL;
  }
}

export function evaluateLiteral(node: Node): { ok: true; value: unknown } | { ok: false } {
  const value = literalValue(node);
  return value === NOT_LITERAL ? { ok: false } : { ok: true, value };
}

/** The static name of an object property, or null for computed keys and spreads. */
export function propertyKey(property: Node): string | null {
  if (property.type !== "Property" || property.computed || property.kind !== "init") return null;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return null;
}

/** Properties of an object literal by static key. Spreads and computed keys are left out. */
export function objectProperties(node: Node): Map<string, Node> | null {
  const object = unwrap(node);
  if (object.type !== "ObjectExpression") return null;
  const properties = new Map<string, Node>();
  for (const property of object.properties) {
    const key = propertyKey(property);
    if (key !== null && property.type === "Property") properties.set(key, property.value);
  }
  return properties;
}

/** A step option as the diagram shows it: the literal, or the expression's source. */
export function detailValue(source: WorkflowSource, node: Node): WorkflowDetailValue {
  const literal = evaluateLiteral(node);
  if (literal.ok) return { literal: literal.value };
  const text = source.slice(node).replace(/\s+/g, " ").trim();
  return {
    expression:
      text.length > MAX_EXPRESSION_LENGTH ? `${text.slice(0, MAX_EXPRESSION_LENGTH - 1)}…` : text,
  };
}

/** Reads a step label: a string literal, or a template literal whose dynamic parts show as `…`. */
export function readLabel(node: Node | undefined): WorkflowLabel | null {
  if (!node) return null;
  const label = unwrap(node);
  if (label.type === "Literal" && typeof label.value === "string") {
    const text = label.value.trim();
    return text ? { text, dynamic: false } : null;
  }
  if (label.type === "TemplateLiteral") {
    const text = label.quasis
      .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
      .join("…")
      .trim();
    return text && text !== "…" ? { text, dynamic: label.expressions.length > 0 } : null;
  }
  return null;
}

export function readString(node: Node | undefined): string | null {
  if (!node) return null;
  const value = evaluateLiteral(node);
  return value.ok && typeof value.value === "string" ? value.value : null;
}
