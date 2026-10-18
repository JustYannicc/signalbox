import * as SchemaAST from "effect/SchemaAST";
import type { Table, TableMap } from "../table.ts";

import { LUNORA_DOMAIN_ID_FIELD, lunoraFieldName } from "./lunoraFields.ts";
import { emitStoredField, LunoraSchemaEmitError } from "./lunoraValidators.ts";
export { LunoraSchemaEmitError } from "./lunoraValidators.ts";

const RESERVED_KEY_INDEX = "__sync_key";
const RESERVED_ROW_FIELDS = new Set(["_id", "_creationTime", LUNORA_DOMAIN_ID_FIELD]);

export interface LunoraSchemaEmission<Tables extends TableMap> {
  readonly source: string;
  /** Keeps the Effect row schemas and key/unique-index metadata for runtime enforcement. */
  readonly tables: Tables;
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

function isIndexableScalar(ast: SchemaAST.AST): boolean {
  if (isOptional(ast) || (ast.encoding !== undefined && ast.encoding.length > 0)) return false;
  switch (ast._tag) {
    case "String":
    case "Number":
    case "Boolean":
    case "Null":
      return true;
    case "Literal":
      return (
        (typeof ast.literal === "string" ||
          typeof ast.literal === "boolean" ||
          typeof ast.literal === "number") &&
        (typeof ast.literal !== "number" || Number.isFinite(ast.literal))
      );
    case "Union":
      return (
        !ast.types.some((member) => member._tag === "Undefined") &&
        ast.types.length > 0 &&
        ast.types.every(isIndexableScalar)
      );
    default:
      return false;
  }
}

function emitTable(name: string, definition: Table, rootPath: string): string {
  const tablePath = `${rootPath}.${name}`;
  if (name.trim().length === 0) fail(tablePath, "table names must not be empty");
  const row = definition.row.ast;
  if (row._tag !== "Objects" || row.indexSignatures.length !== 0) {
    fail(`${tablePath}.row`, "a table row must be a fixed Effect Schema.Struct");
  }

  const rowFields = new Map<string, SchemaAST.AST>();
  const fields = row.propertySignatures.map((property) => {
    if (typeof property.name !== "string") {
      return fail(`${tablePath}.row`, "symbol-keyed object fields are not JSON values");
    }
    if (RESERVED_ROW_FIELDS.has(property.name)) {
      return fail(
        `${tablePath}.row.${property.name}`,
        `field ${quote(property.name)} is reserved by Lunora`,
      );
    }
    rowFields.set(property.name, property.type);
    return `    ${quote(lunoraFieldName(property.name))}: ${emitStoredField(property.type, `${tablePath}.row.${property.name}`)},`;
  });

  const checkIndex = (indexName: string, indexFields: readonly string[], path: string) => {
    if (indexFields.length === 0) fail(path, "indexes need at least one field");
    if (new Set(indexFields).size !== indexFields.length) fail(path, "index fields must be unique");
    for (const field of indexFields) {
      const fieldSchema = rowFields.get(field);
      if (fieldSchema === undefined)
        fail(path, `field ${quote(field)} is not declared in the row schema`);
      if (!isIndexableScalar(fieldSchema)) {
        fail(
          path,
          `field ${quote(field)} must be a required, untransformed JSON scalar to be indexed`,
        );
      }
    }
  };

  checkIndex(RESERVED_KEY_INDEX, definition.key, `${tablePath}.key`);
  for (const [indexName, index] of Object.entries(definition.indexes)) {
    if (indexName === RESERVED_KEY_INDEX) {
      fail(
        `${tablePath}.indexes.${indexName}`,
        `index name ${quote(RESERVED_KEY_INDEX)} is reserved`,
      );
    }
    checkIndex(indexName, index.fields, `${tablePath}.indexes.${indexName}`);
  }

  const indexLines = [
    `  .index(${quote(RESERVED_KEY_INDEX)}, ${JSON.stringify(definition.key.map(lunoraFieldName))})`,
    ...Object.entries(definition.indexes)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(
        ([indexName, index]) =>
          `  .index(${quote(indexName)}, ${JSON.stringify(index.fields.map(lunoraFieldName))})`,
      ),
  ];

  return `  ${quote(name)}: defineTable({${fields.length === 0 ? "" : `\n${fields.join("\n")}\n  `}})\n${indexLines.join("\n")},`;
}

/** Emits literal v.* syntax because Lunora's schema codegen cannot evaluate helper functions. */
export function emitLunoraSchema<const Tables extends TableMap>(
  tables: Tables,
): LunoraSchemaEmission<Tables> {
  const tableLines = Object.entries(tables)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, definition]) => emitTable(name, definition, "schema"));

  return {
    source: `import { defineSchema, defineTable, v } from "lunorash/server";\n\nexport default defineSchema({\n${tableLines.join("\n")}\n});\n`,
    tables,
  };
}
