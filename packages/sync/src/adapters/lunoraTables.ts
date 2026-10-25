import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DatabaseReader, DatabaseWriter } from "lunorash/server";

import {
  TableReadError,
  TableWriteError,
  pageCursorSchema,
  type ReadTable,
  type Row,
  type Table,
  type TableMap,
  type WriteTable,
} from "../table.ts";

const KEY_INDEX = "__sync_key";
// SQLite index equality conflates false/0 and true/1; decoded scalar tuples retain their types.
const canonicalKey = (values: readonly unknown[]) => JSON.stringify(values);
const Index = Schema.Struct({
  fields: Schema.Array(Schema.String),
  unique: Schema.optionalKey(Schema.Boolean),
});
const RecordValue = Schema.Record(Schema.String, Schema.Unknown);
const Cursor = Schema.fromJsonString(
  Schema.Struct({ query: Schema.String, cursor: Schema.String }),
);
const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);
const Selector = Schema.Struct({
  prefix: Schema.optionalKey(Schema.Array(Scalar)),
  range: Schema.optionalKey(
    Schema.Struct({ from: Schema.optionalKey(Scalar), to: Schema.optionalKey(Scalar) }),
  ),
});

const decodeIndexes = Schema.decodeUnknownSync(Schema.Record(Schema.String, Index));
const decodeRecord = Schema.decodeUnknownPromise(RecordValue);
const decodeScalar = Schema.decodeUnknownPromise(Scalar);
const decodeSelector = Schema.decodeUnknownPromise(Selector);
const decodeCursor = Schema.decodeUnknownPromise(Cursor);
const encodeCursor = Schema.encodePromise(Cursor);
const decodeJsonObject = Schema.decodeUnknownPromise(Schema.JsonObject);
const isReadError = Schema.is(TableReadError);
const isWriteError = Schema.is(TableWriteError);

export type LunoraReadTables<Tables extends TableMap> = {
  readonly [K in keyof Tables]: ReadTable<Tables[K]>;
};
export type LunoraWriteTables<Tables extends TableMap> = {
  readonly [K in keyof Tables]: WriteTable<Tables[K]>;
};

const readError = (table: string, reason: TableReadError["reason"] = "invalid_query") =>
  new TableReadError({ table, reason });
const writeError = (table: string, reason: TableWriteError["reason"]) =>
  new TableWriteError({ table, reason });

function makeTable<T extends Table>(
  name: string,
  definition: T,
  db: DatabaseReader,
  maxPageSize: number,
) {
  // Preserve the exact descriptor schema through the generic table constraint.
  const rowSchema = definition.row as Schema.ConstraintCodec<Row<T>, unknown, never, never>;
  const decodeRow = Schema.decodeUnknownPromise(Schema.toType(rowSchema), {
    onExcessProperty: "error",
  });
  const indexes = decodeIndexes(definition.indexes);
  const decodeStored = async (document: Record<string, unknown>) => {
    const { _id, _creationTime, ...row } = document;
    try {
      return await decodeRow(row);
    } catch {
      throw readError(name, "invalid_row");
    }
  };
  const values = async (fields: readonly string[], key: unknown) => {
    try {
      if (fields.length === 1) return [await decodeScalar(key)];
      const record = await decodeRecord(key);
      if (
        Object.keys(record).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(record, field))
      ) {
        throw readError(name);
      }
      return await Promise.all(fields.map((field) => decodeScalar(record[field])));
    } catch {
      throw readError(name);
    }
  };
  const lookup = (index: string, fields: readonly string[], keys: readonly unknown[]) => {
    const key = canonicalKey(keys);
    return db
      .query(name)
      .withIndex(index, (builder) => fields.reduce((q, field, i) => q.eq(field, keys[i]), builder))
      .filter((document) => canonicalKey(fields.map((field) => document[field])) === key)
      .unique();
  };
  const find = async (key: unknown) =>
    lookup(KEY_INDEX, definition.key, await values(definition.key, key));
  const getIndex = (index: string) => {
    const declared = Object.hasOwn(indexes, index) ? indexes[index] : undefined;
    if (!declared) throw readError(name);
    return declared;
  };
  const read = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) => (isReadError(error) ? error : readError(name, "storage_unavailable")),
    });
  const reads: ReadTable<T> = {
    get: (key) =>
      read(async () => {
        const document = await find(key);
        return document === null ? Option.none() : Option.some(await decodeStored(document));
      }),
    unique: (index, key) =>
      read(async () => {
        const declared = getIndex(index);
        if (!declared.unique) throw readError(name);
        const document = await lookup(index, declared.fields, await values(declared.fields, key));
        return document === null ? Option.none() : Option.some(await decodeStored(document));
      }),
    page: (index, options) =>
      read(async () => {
        if (
          !Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > maxPageSize
        )
          throw readError(name);
        const declared = getIndex(index);
        const selector = await decodeSelector({
          ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
          ...(options.range === undefined ? {} : { range: options.range }),
        }).catch(() => {
          throw readError(name);
        });
        const prefix = selector.prefix ?? [];
        const prefixFields = declared.fields.slice(0, prefix.length);
        const prefixKey = canonicalKey(prefix);
        const next = declared.fields[prefix.length];
        if (
          prefix.length > declared.fields.length ||
          (selector.range !== undefined && next === undefined)
        )
          throw readError(name);
        const order = options.order ?? "asc";
        if (order !== "asc" && order !== "desc") throw readError(name);
        const query = JSON.stringify([
          name,
          index,
          order,
          prefix,
          selector.range?.from ?? null,
          selector.range?.to ?? null,
          selector.range !== undefined && Object.hasOwn(selector.range, "from"),
          selector.range !== undefined && Object.hasOwn(selector.range, "to"),
        ]);
        const decodedCursor =
          options.after === undefined
            ? undefined
            : await decodeCursor(options.after).catch(() => {
                throw readError(name, "invalid_cursor");
              });
        if (decodedCursor !== undefined && decodedCursor.query !== query)
          throw readError(name, "invalid_cursor");
        const page = await db
          .query(name)
          .withIndex(index, (builder) => {
            let range = prefix.reduce((q, value, i) => q.eq(declared.fields[i]!, value), builder);
            if (next !== undefined && selector.range?.from !== undefined)
              range = range.gte(next, selector.range.from);
            if (next !== undefined && selector.range?.to !== undefined)
              range = range.lte(next, selector.range.to);
            return range;
          })
          .filter(
            (document) => canonicalKey(prefixFields.map((field) => document[field])) === prefixKey,
          )
          .order(order)
          .paginate({ numItems: options.limit, cursor: decodedCursor?.cursor ?? null });
        if (page.page.length > options.limit || (!page.isDone && page.continueCursor === null))
          throw readError(name);
        const after = page.isDone
          ? undefined
          : await encodeCursor({ query, cursor: page.continueCursor! });
        return {
          rows: await Promise.all(page.page.map(decodeStored)),
          after:
            after === undefined
              ? undefined
              : Schema.decodeSync(pageCursorSchema(definition, index))(after),
        };
      }),
  };

  const writes = (writer: DatabaseWriter): WriteTable<T> => {
    // A mutation may use concurrent Effects; keep each uniqueness check and write together.
    let pending = Promise.resolve();
    const serial = (run: () => Promise<void>) => {
      const next = pending.then(run);
      pending = next.catch(() => {});
      return next;
    };
    const write = (run: () => Promise<void>) =>
      Effect.tryPromise({
        try: () => serial(run),
        catch: (error) => (isWriteError(error) ? error : writeError(name, "storage_unavailable")),
      });
    const validate = async (input: unknown) => {
      try {
        return await decodeJsonObject(await decodeRow(input));
      } catch {
        throw writeError(name, "invalid_row");
      }
    };
    const id = (document: Record<string, unknown>) => {
      if (typeof document._id !== "string") throw writeError(name, "storage_unavailable");
      return writer.asId(name, document._id);
    };
    const existing = async (key: unknown) => {
      const document = await find(key);
      if (document === null) throw writeError(name, "missing_row");
      return document;
    };
    const checkKey = async (key: unknown, row: Record<string, unknown>) => {
      const expected = await values(definition.key, key);
      if (definition.key.some((field, i) => row[field] !== expected[i]))
        throw writeError(name, "key_mismatch");
    };
    const checkUnique = async (
      row: Record<string, unknown>,
      previous?: Record<string, unknown>,
    ) => {
      for (const [index, fields, reason] of [
        [KEY_INDEX, definition.key, "key_conflict"],
        ...Object.entries(indexes)
          .filter(([, index]) => index.unique)
          .map(([index, declaration]) => [index, declaration.fields, "unique_conflict"] as const),
      ] as const) {
        const conflict = await lookup(
          index,
          fields,
          fields.map((field) => row[field]),
        );
        if (conflict !== null && (previous === undefined || conflict._id !== previous._id))
          throw writeError(name, reason);
      }
    };
    return {
      ...reads,
      insert: (input) =>
        write(async () => {
          const row = await validate(input);
          await checkUnique(row);
          await writer.insert(name, row);
        }),
      replace: (key, input) =>
        write(async () => {
          const row = await validate(input);
          await checkKey(key, row);
          const previous = await existing(key);
          await checkUnique(row, previous);
          await writer.replace(id(previous), row);
        }),
      patch: (key, patch) =>
        write(async () => {
          const fields = await decodeRecord(patch);
          if (definition.key.some((field) => Object.hasOwn(fields, field)))
            throw writeError(name, "key_mismatch");
          const previous = await existing(key);
          const row = await validate({
            ...(await decodeRecord(await decodeStored(previous))),
            ...fields,
          });
          await checkUnique(row, previous);
          await writer.replace(id(previous), row);
        }),
      delete: (key) =>
        write(async () => {
          await writer.delete(id(await existing(key)));
        }),
    };
  };
  return { reads, writes };
}

function assertPageSize(maxPageSize: number) {
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < 1)
    throw new RangeError("maxPageSize must be a positive safe integer");
}

export function makeLunoraReadTables<const Tables extends TableMap>(
  tables: Tables,
  db: DatabaseReader,
  maxPageSize = 100,
): LunoraReadTables<Tables> {
  assertPageSize(maxPageSize);
  // The loop fills every own table key with a handle built from that exact descriptor.
  const result = {} as { -readonly [K in keyof Tables]: ReadTable<Tables[K]> };
  for (const name in tables) {
    if (Object.hasOwn(tables, name))
      result[name] = makeTable<Tables[typeof name]>(name, tables[name]!, db, maxPageSize).reads;
  }
  return result;
}

export function makeLunoraWriteTables<const Tables extends TableMap>(
  tables: Tables,
  db: DatabaseWriter,
  maxPageSize = 100,
): LunoraWriteTables<Tables> {
  assertPageSize(maxPageSize);
  const result = {} as { -readonly [K in keyof Tables]: WriteTable<Tables[K]> };
  for (const name in tables) {
    if (Object.hasOwn(tables, name))
      result[name] = makeTable<Tables[typeof name]>(name, tables[name]!, db, maxPageSize).writes(
        db,
      );
  }
  return result;
}
