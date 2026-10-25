import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

import type { SyncSchema } from "../definition.ts";

/** A schema cannot be represented by the generated native validator. */
export class LunoraSchemaEmitError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "LunoraSchemaEmitError";
    this.path = path;
  }
}

function fail(path: string, reason: string): never {
  throw new LunoraSchemaEmitError(path, reason);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isOptional(ast: SchemaAST.AST): boolean {
  return ast.context?.isOptional === true;
}

function withoutUndefined(ast: SchemaAST.AST, path: string): ReadonlyArray<SchemaAST.AST> {
  const members = ast._tag === "Union" ? ast.types : [ast];
  const defined = members.filter((member) => member._tag !== "Undefined");
  if (defined.length === 0) return fail(path, "an optional field must have a JSON value schema");
  return defined;
}

function emitNode(ast: SchemaAST.AST, path: string, allowUnknown: boolean): string {
  if (ast.encoding !== undefined && ast.encoding.length > 0) {
    return fail(
      path,
      allowUnknown
        ? "encoded Effect Schema retains an unsupported transformation"
        : "Effect codecs/transforms are not supported for stored columns",
    );
  }

  switch (ast._tag) {
    case "String":
      return "v.string()";
    case "Number":
      return "v.number()";
    case "Boolean":
      return "v.boolean()";
    case "Null":
      return "v.null()";
    case "Literal":
      if (
        typeof ast.literal !== "string" &&
        typeof ast.literal !== "number" &&
        typeof ast.literal !== "boolean"
      ) {
        return fail(path, "only JSON string, number, and boolean literals are supported");
      }
      if (typeof ast.literal === "number" && !Number.isFinite(ast.literal)) {
        return fail(path, "non-finite number literals are not JSON values");
      }
      return `v.literal(${typeof ast.literal === "string" ? quote(ast.literal) : String(ast.literal)})`;
    case "Arrays":
      if (ast.elements.length !== 0 || ast.rest.length !== 1) {
        return fail(path, "only homogeneous Effect Schema.Array values are supported");
      }
      return `v.array(${emitRequired(ast.rest[0]!, `${path}[]`, allowUnknown)})`;
    case "Objects": {
      if (ast.indexSignatures.length !== 0) {
        return fail(
          path,
          allowUnknown
            ? "dynamic record schemas are not supported by generated native validators"
            : "dynamic record schemas are not supported in stored columns",
        );
      }
      const fields = ast.propertySignatures.map((property) => {
        if (typeof property.name !== "string") {
          return fail(path, "symbol-keyed object fields are not JSON values");
        }
        return `    ${quote(property.name)}: ${emitField(property.type, `${path}.${property.name}`, allowUnknown)},`;
      });
      return `v.object({${fields.length === 0 ? "" : `\n${fields.join("\n")}\n  `}})`;
    }
    case "Union": {
      if (ast.types.some((member) => member._tag === "Undefined" || member._tag === "Void")) {
        return fail(
          path,
          allowUnknown
            ? "undefined must be represented by the outer WireValue tag"
            : "undefined is not a stored JSON value; make the object field optional instead",
        );
      }
      const members = ast.types
        .filter((member) => member._tag !== "Never")
        .map((member, index) => emitRequired(member, `${path}<${index}>`, allowUnknown));
      if (members.length === 0) return fail(path, "empty unions are not supported");
      if (members.length === 1) return members[0]!;
      return `v.union(${members.join(", ")})`;
    }
    case "Unknown":
    case "Any":
      if (allowUnknown) return "v.any()";
      return fail(path, `Effect Schema ${ast._tag} is not a supported JSON column`);
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
    case "Undefined":
    case "Void":
    case "Never":
    case "ObjectKeyword":
    case "Enum":
    case "TemplateLiteral":
    case "Declaration":
    case "Suspend":
      return fail(path, `Effect Schema ${ast._tag} is not a supported JSON value`);
  }
}

function emitRequired(ast: SchemaAST.AST, path: string, allowUnknown: boolean): string {
  if (isOptional(ast)) return fail(path, "optional values are only supported as object fields");
  return emitNode(ast, path, allowUnknown);
}

function emitField(ast: SchemaAST.AST, path: string, allowUnknown: boolean): string {
  if (!isOptional(ast)) return emitRequired(ast, path, allowUnknown);
  const members = withoutUndefined(ast, path).map((member, index) =>
    emitNode(member, `${path}<${index}>`, allowUnknown),
  );
  const value = members.length === 1 ? members[0]! : `v.union(${members.join(", ")})`;
  return `v.optional(${value})`;
}

/** Existing stored-column compiler. Its literal output is kept stable for mergeable schema diffs. */
export function emitStoredField(ast: SchemaAST.AST, path: string): string {
  return emitField(ast, path, false);
}

function isAbsent(ast: SchemaAST.AST): boolean {
  return ast._tag === "Undefined" || ast._tag === "Void";
}

/** True when the encoded schema has no values, so an enclosing tagged branch is impossible. */
export function isNeverSchema(schema: SyncSchema): boolean {
  const ast = Schema.toEncoded(schema).ast;
  if (ast._tag === "Never") return true;
  return ast._tag === "Union" && ast.types.every((member) => member._tag === "Never");
}

/** Emit a concrete Lunora validator for the JSON encoding inside a WireValue envelope. */
export function emitWireValueValidator(schema: SyncSchema, path: string): string {
  const ast = Schema.toEncoded(schema).ast;
  const members = ast._tag === "Union" ? ast.types : [ast];
  const hasAbsent = members.some(isAbsent);
  const defined = members.filter((member) => !isAbsent(member) && member._tag !== "Never");
  const variants: string[] = [];

  if (hasAbsent) variants.push("v.object({ defined: v.literal(false) })");
  if (defined.length > 0) {
    const values = defined.map((member, index) =>
      emitRequired(member, `${path}.value<${index}>`, true),
    );
    const value = values.length === 1 ? values[0]! : `v.union(${values.join(", ")})`;
    variants.push(`v.object({ defined: v.literal(true), value: ${value} })`);
  }
  if (variants.length === 0) return fail(path, "schema has no JSON-representable WireValue branch");
  return variants.length === 1 ? variants[0]! : `v.union(${variants.join(", ")})`;
}

/** Emit the raw encoded schema value where the surrounding native object already supplies a field. */
export function emitEncodedValidator(schema: SyncSchema, path: string): string {
  const ast = Schema.toEncoded(schema).ast;
  if (isAbsent(ast) || ast._tag === "Never") {
    return fail(path, "schema must encode to a defined JSON value");
  }
  if (ast._tag === "Union" && ast.types.some((member) => isAbsent(member))) {
    return fail(path, "undefined must be represented by the WireValue envelope");
  }
  return emitRequired(ast, path, true);
}

/** Whether the encoded schema has any inhabited member outside Void/Undefined/Never. */
export function hasDefinedValue(schema: SyncSchema): boolean {
  const ast = Schema.toEncoded(schema).ast;
  const members = ast._tag === "Union" ? ast.types : [ast];
  return members.some((member) => !isAbsent(member) && member._tag !== "Never");
}
