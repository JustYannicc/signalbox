import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import type { CallExpression, Node } from "oxc-parser";

import { evaluateLiteral, propertyKey, unwrap } from "./literals.ts";
import type { WorkflowSource } from "./source.ts";

const CONTRACT_HINT =
  "Declare contracts with Effect Schema, e.g. input: Schema.Struct({ issueId: Schema.String })";
type SchemaExpression = Exclude<CallExpression["arguments"][number], { type: "SpreadElement" }>;

/**
 * Returns namespace imports that can name Effect Schema constructors. The
 * compiler recognizes syntax from these bindings without running source code.
 */
export function schemaNamespaceImports(statements: ReadonlyArray<Node>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    if (statement.source.value === "effect/Schema") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") names.add(specifier.local.name);
      }
    } else if (statement.source.value === "effect") {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === "Schema"
        ) {
          names.add(specifier.local.name);
        }
      }
    }
  }
  return names;
}

function schemaMember(node: Node, imports: ReadonlySet<string>): string | null {
  const member = unwrap(node);
  if (
    member.type !== "MemberExpression" ||
    member.computed ||
    member.object.type !== "Identifier" ||
    !imports.has(member.object.name) ||
    member.property.type !== "Identifier"
  ) {
    return null;
  }
  return member.property.name;
}

function call(node: Node, name: string, imports: ReadonlySet<string>): SchemaExpression[] | null {
  const expression = unwrap(node);
  if (expression.type !== "CallExpression" || schemaMember(expression.callee, imports) !== name) {
    return null;
  }
  const args: SchemaExpression[] = [];
  for (const argument of expression.arguments) {
    if (argument.type === "SpreadElement") return null;
    args.push(argument);
  }
  return args;
}

function methodCall(node: Node, name: string): { receiver: Node; args: SchemaExpression[] } | null {
  const expression = unwrap(node);
  if (
    expression.type !== "CallExpression" ||
    expression.callee.type !== "MemberExpression" ||
    expression.callee.computed ||
    expression.callee.property.type !== "Identifier" ||
    expression.callee.property.name !== name
  ) {
    return null;
  }
  const args: SchemaExpression[] = [];
  for (const argument of expression.arguments) {
    if (argument.type === "SpreadElement") return null;
    args.push(argument);
  }
  return { receiver: expression.callee.object, args };
}

function arrayItems(node: Node): Node[] | null {
  const expression = unwrap(node);
  if (expression.type !== "ArrayExpression" || expression.elements.some((item) => item === null)) {
    return null;
  }
  const items: Node[] = [];
  for (const item of expression.elements) {
    if (!item || item.type === "SpreadElement") return null;
    items.push(item);
  }
  return items;
}

function primitiveLiteral(node: Node): string | number | boolean | undefined {
  const value = evaluateLiteral(node);
  if (!value.ok) return undefined;
  if (
    typeof value.value === "string" ||
    typeof value.value === "number" ||
    typeof value.value === "boolean"
  ) {
    return value.value;
  }
  return undefined;
}

function parseSchema(node: Node, imports: ReadonlySet<string>): Schema.Top | null {
  const expression = unwrap(node);
  const member = schemaMember(expression, imports);
  switch (member) {
    case "String":
      return Schema.String;
    case "Number":
      return Schema.Number;
    case "Int":
      return Schema.Int;
    case "Boolean":
      return Schema.Boolean;
    case "Null":
      return Schema.Null;
    case "Unknown":
      return Schema.Unknown;
  }

  const literalArgs = call(expression, "Literal", imports);
  if (literalArgs) {
    if (literalArgs.length !== 1) return null;
    const literal = primitiveLiteral(literalArgs[0]!);
    return literal === undefined ? null : Schema.Literal(literal);
  }

  const literalsArgs = call(expression, "Literals", imports);
  if (literalsArgs) {
    if (literalsArgs.length !== 1) return null;
    const literalNodes = arrayItems(literalsArgs[0]!);
    if (!literalNodes?.length) return null;
    const literals = literalNodes.map(primitiveLiteral);
    if (literals.some((literal) => literal === undefined)) return null;
    const members = literals.map((literal) => Schema.Literal(literal!));
    return Schema.Union([members[0]!, ...members.slice(1)]);
  }

  const arrayArgs = call(expression, "Array", imports);
  if (arrayArgs) {
    if (arrayArgs.length !== 1) return null;
    const item = parseSchema(arrayArgs[0]!, imports);
    return item ? Schema.Array(item) : null;
  }

  const unionArgs = call(expression, "Union", imports);
  if (unionArgs) {
    if (unionArgs.length !== 1) return null;
    const members = arrayItems(unionArgs[0]!);
    if (!members?.length) return null;
    const schemas: Schema.Top[] = [];
    for (const item of members) {
      const schema = parseSchema(item, imports);
      if (!schema) return null;
      schemas.push(schema);
    }
    return Schema.Union([schemas[0]!, ...schemas.slice(1)]);
  }

  const structArgs = call(expression, "Struct", imports);
  if (structArgs) {
    if (structArgs.length !== 1) return null;
    const fieldsNode = unwrap(structArgs[0]!);
    if (fieldsNode.type !== "ObjectExpression") return null;
    const fields: Record<string, Schema.Top> = {};
    for (const property of fieldsNode.properties) {
      const name = propertyKey(property);
      if (
        name === null ||
        name === "__proto__" ||
        property.type !== "Property" ||
        property.shorthand
      ) {
        return null;
      }

      const optionalArgs = call(property.value, "optionalKey", imports);
      const optional = optionalArgs !== null;
      const fieldNode = optional ? optionalArgs![0] : property.value;
      if (!fieldNode || (optional && optionalArgs!.length !== 1)) return null;
      const schema = parseSchema(fieldNode, imports);
      if (!schema) return null;
      fields[name] = optional ? Schema.optionalKey(schema) : schema;
    }
    return Schema.Struct(fields);
  }

  const optionalArgs = call(expression, "optional", imports);
  if (optionalArgs) {
    if (optionalArgs.length !== 1) return null;
    const inner = parseSchema(optionalArgs[0]!, imports);
    return inner ? Schema.optional(inner) : null;
  }

  const nullOrArgs = call(expression, "NullOr", imports);
  if (nullOrArgs) {
    if (nullOrArgs.length !== 1) return null;
    const inner = parseSchema(nullOrArgs[0]!, imports);
    return inner ? Schema.NullOr(inner) : null;
  }

  const annotation = methodCall(expression, "annotate");
  if (annotation) {
    if (annotation.args.length !== 1) return null;
    const schema = parseSchema(annotation.receiver, imports);
    const literal = evaluateLiteral(annotation.args[0]!);
    const metadata = literal.ok ? literal.value : null;
    if (
      !schema ||
      metadata === null ||
      typeof metadata !== "object" ||
      Object.keys(metadata).some((key) => key !== "description")
    ) {
      return null;
    }
    const description = Object.getOwnPropertyDescriptor(metadata, "description")?.value;
    return typeof description === "string" ? schema.annotate({ description }) : null;
  }

  return null;
}

export function compileSchemaContract(
  source: WorkflowSource,
  field: "input" | "output",
  node: Node,
  imports: ReadonlySet<string>,
): Schema.Json | null {
  try {
    const schema = parseSchema(node, imports);
    if (!schema) {
      source.error(
        node,
        `meta.${field} must be a supported Effect Schema expression.`,
        CONTRACT_HINT,
      );
      return null;
    }
    return SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast));
  } catch {
    source.error(
      node,
      `meta.${field} could not be serialized as an Effect Schema contract.`,
      CONTRACT_HINT,
    );
    return null;
  }
}
