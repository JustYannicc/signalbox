import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type NonEmpty<T> = readonly [T, ...T[]];
type AnyRowSchema = Schema.ConstraintCodec<unknown, unknown, never, never>;
type ReservedStorageField = "_id" | "_creationTime";
type KeyScalar = string | number | boolean | null;
type KeyField<Row> = {
  [Field in keyof Row]-?: {} extends Pick<Row, Field>
    ? never
    : Row[Field] extends KeyScalar
      ? Field
      : never;
}[keyof Row] &
  string;
export type Table<
  RowSchema extends AnyRowSchema = AnyRowSchema,
  KeyFields extends readonly string[] = readonly string[],
  Indexes extends object = object,
> = {
  readonly row: RowSchema;
  readonly key: KeyFields;
  readonly indexes: Indexes;
  readonly [tableDefinitionBrand]: true;
};
type AnyTable = Table;

export type TableMap = Readonly<Record<string, Table>>;

const tableDefinitionBrand: unique symbol = Symbol("TableDefinition");

export type IndexDefinition<
  Row,
  Fields extends NonEmpty<KeyField<Row>> = NonEmpty<KeyField<Row>>,
> = {
  readonly fields: Fields;
  readonly unique?: boolean;
};

type IndexMap<Row> = Readonly<Record<string, IndexDefinition<Row>>>;

/**
 * Schema and index metadata for one home table. The key fields identify a row uniquely;
 * the storage id stays private to the adapter.
 */
export interface TableDefinition<
  RowSchema extends AnyRowSchema,
  KeyFields extends NonEmpty<KeyField<Schema.Schema.Type<RowSchema>>>,
  Indexes extends IndexMap<Schema.Schema.Type<RowSchema>>,
> extends Table<RowSchema, KeyFields, Indexes> {
  readonly row: RowSchema;
  readonly key: KeyFields;
  readonly indexes: Indexes;
}

type HasReservedStorageField<Row> = Row extends unknown
  ? Extract<keyof Row, ReservedStorageField> extends never
    ? false
    : true
  : never;
type RowSchemaWithoutReservedStorageFields<RowSchema extends AnyRowSchema> =
  true extends HasReservedStorageField<Schema.Schema.Type<RowSchema>> ? never : unknown;

/** Defines the domain key and queryable indexes without exposing a storage engine's id. */
export const table = <
  RowSchema extends AnyRowSchema,
  const KeyFields extends NonEmpty<KeyField<Schema.Schema.Type<RowSchema>>>,
  const Indexes extends IndexMap<Schema.Schema.Type<RowSchema>>,
>(definition: {
  readonly row: RowSchema & RowSchemaWithoutReservedStorageFields<RowSchema>;
  readonly key: KeyFields;
  readonly indexes: Indexes;
}): TableDefinition<RowSchema, KeyFields, Indexes> =>
  Object.freeze({
    ...definition,
    indexes: Object.freeze({ ...definition.indexes }),
    [tableDefinitionBrand]: true as const,
  });

export type Row<T extends AnyTable> = Schema.Schema.Type<T["row"]>;

type TableKeyFields<T> = T extends {
  readonly key: infer Fields extends readonly string[];
}
  ? Fields
  : never;

/** A single domain key is its field value; a composite key is a readonly object of its fields. */
export type Key<T extends AnyTable> = DomainKey<Row<T>, TableKeyFields<T>>;

type DomainKey<RowValue, Fields extends readonly string[]> = Fields extends readonly [
  infer Only extends keyof RowValue & string,
]
  ? RowValue[Only]
  : { readonly [Field in Fields[number] & keyof RowValue]: RowValue[Field] };

type IndexNames<T extends AnyTable> = keyof T["indexes"] & string;

type UniqueIndexNames<T extends AnyTable> = {
  [Name in keyof T["indexes"]]-?: T["indexes"][Name] extends {
    readonly unique: true;
  }
    ? Name
    : never;
}[keyof T["indexes"]] &
  string;

type IndexFields<T extends AnyTable, Name extends IndexNames<T>> = Name extends keyof T["indexes"]
  ? T["indexes"][Name] extends {
      readonly fields: infer Fields extends readonly KeyField<Row<T>>[];
    }
    ? Fields
    : never
  : never;

type IndexKey<T extends AnyTable, Name extends IndexNames<T>> = DomainKey<
  Row<T>,
  IndexFields<T, Name>
>;

type PageSelector<
  RowValue,
  Fields extends readonly KeyField<RowValue>[],
  Prefix extends readonly unknown[] = readonly [],
> = Fields extends readonly [
  infer Head extends KeyField<RowValue>,
  ...infer Tail extends readonly KeyField<RowValue>[],
]
  ?
      | ((Prefix extends readonly []
          ? { readonly prefix?: Prefix }
          : { readonly prefix: Prefix }) & {
          /** Bounds the next index field after prefix; from and to are inclusive. */
          readonly range?: {
            readonly from?: RowValue[Head];
            readonly to?: RowValue[Head];
          };
        })
      | PageSelector<RowValue, Tail, readonly [...Prefix, RowValue[Head]]>
  : { readonly prefix: Prefix; readonly range?: never };

declare const pageCursorBrand: unique symbol;

/** Opaque continuation cursor scoped to one table and index. */
export type PageCursor<T extends AnyTable, Name extends IndexNames<T>> = string & {
  readonly [pageCursorBrand]: {
    readonly table: T;
    readonly index: Name;
  };
};

/** Builds the codec for a continuation cursor scoped to one validated table and index. */
export const pageCursorSchema = <T extends AnyTable, Name extends IndexNames<T>>(
  table: T,
  index: Name,
): Schema.Codec<PageCursor<T, Name>, string, never, never> => {
  if (!Object.prototype.hasOwnProperty.call(table.indexes, index)) {
    throw new Error(`Unknown table index: ${index}`);
  }

  return Schema.String.pipe(
    Schema.refine((value): value is PageCursor<T, Name> => typeof value === "string", {
      identifier: `PageCursor<${index}>`,
    }),
  );
};

export type TablePage<T extends AnyTable, Name extends IndexNames<T>> = {
  readonly rows: ReadonlyArray<Row<T>>;
  readonly after: PageCursor<T, Name> | undefined;
};

export type IndexPageOptions<T extends AnyTable, Name extends IndexNames<T>> = PageSelector<
  Row<T>,
  IndexFields<T, Name>
> & {
  /** The adapter enforces the configured maximum page size. */
  readonly limit: number;
  readonly after?: PageCursor<T, Name>;
  /** Defaults to ascending index order. */
  readonly order?: "asc" | "desc";
};

export class TableReadError extends Schema.TaggedError<TableReadError>()("TableReadError", {
  table: Schema.String,
  reason: Schema.Literals([
    "invalid_row",
    "invalid_cursor",
    "invalid_query",
    "storage_unavailable",
  ]),
}) {}

export class TableWriteError extends Schema.TaggedError<TableWriteError>()("TableWriteError", {
  table: Schema.String,
  reason: Schema.Literals([
    "key_conflict",
    "key_mismatch",
    "missing_row",
    "invalid_row",
    "unique_conflict",
    "storage_unavailable",
  ]),
}) {}

export type TableError = TableReadError | TableWriteError;

/** Transaction-scoped table reads. Pages must be bounded by the adapter's configured maximum. */
export interface ReadTable<T extends AnyTable> {
  /** Missing keys return None. */
  readonly get: (key: Key<T>) => Effect.Effect<Option.Option<Row<T>>, TableReadError>;
  /** Available only for indexes declared unique. */
  readonly unique: <Name extends UniqueIndexNames<T>>(
    index: Name,
    key: IndexKey<T, Name>,
  ) => Effect.Effect<Option.Option<Row<T>>, TableReadError>;
  /** Reads one bounded page in the declared index order. */
  readonly page: <Name extends IndexNames<T>>(
    index: Name,
    options: IndexPageOptions<T, Name>,
  ) => Effect.Effect<TablePage<T, Name>, TableReadError>;
}

/**
 * All writes use one home transaction, and reads through this handle observe its prior writes.
 * The enclosing sync operation commits the durable receipt with this transaction.
 */
export interface WriteTable<T extends AnyTable> extends ReadTable<T> {
  readonly insert: (row: Row<T>) => Effect.Effect<void, TableWriteError>;
  /** Replaces the row addressed by key; the row's domain key must match key. */
  readonly replace: (key: Key<T>, row: Row<T>) => Effect.Effect<void, TableWriteError>;
  /** The declared domain key fields cannot be patched. */
  readonly patch: (
    key: Key<T>,
    patch: Partial<Omit<Row<T>, TableKeyFields<T>[number] & keyof Row<T>>>,
  ) => Effect.Effect<void, TableWriteError>;
  readonly delete: (key: Key<T>) => Effect.Effect<void, TableWriteError>;
}
