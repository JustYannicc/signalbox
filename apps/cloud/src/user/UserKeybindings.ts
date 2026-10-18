import {
  KeybindingRule,
  KeybindingsConfigError,
  MAX_KEYBINDINGS_COUNT,
  type ResolvedKeybindingsConfig,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const isRule = Schema.is(KeybindingRule);
const RulesJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const decodeRules = Schema.decodeUnknownEffect(RulesJson);
const encodeRules = Schema.encodeEffect(RulesJson);
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ revision: Schema.Int, value: Schema.String })),
);

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE user_keybindings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    value TEXT NOT NULL
  )`;
});

export interface KeybindingsSnapshot {
  readonly revision: number;
  readonly keybindings: ResolvedKeybindingsConfig;
}

export class UserKeybindings extends Context.Service<
  UserKeybindings,
  {
    readonly snapshot: Effect.Effect<KeybindingsSnapshot, SqlError>;
    readonly changes: Stream.Stream<KeybindingsSnapshot, SqlError>;
    readonly upsert: (
      input: ServerUpsertKeybindingInput,
    ) => Effect.Effect<KeybindingsSnapshot, SqlError | KeybindingsConfigError>;
    readonly remove: (
      input: ServerRemoveKeybindingInput,
    ) => Effect.Effect<KeybindingsSnapshot, SqlError>;
  }
>()("@signalbox/cloud/user/UserKeybindings") {}

const matches = (entry: unknown, target: KeybindingRule) =>
  isRule(entry) &&
  entry.command === target.command &&
  entry.key === target.key &&
  entry.when === target.when;

const resolved = (state: {
  readonly revision: number;
  readonly rules: readonly unknown[];
}): KeybindingsSnapshot => ({
  revision: state.revision,
  keybindings: mergeWithDefaultKeybindings(
    compileResolvedKeybindingsConfig(state.rules.filter(isRule)),
  ),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* PubSub.sliding<void>(1);
  const read = Effect.gen(function* () {
    const rows = yield* sql`SELECT revision, value FROM user_keybindings WHERE id = 1`;
    const [row] = yield* decodeRows(rows).pipe(Effect.orDie);
    return row === undefined
      ? { revision: 0, rules: [] }
      : { revision: row.revision, rules: yield* decodeRules(row.value).pipe(Effect.orDie) };
  });
  const snapshot = Effect.map(read, resolved);
  const update = (mutate: (rules: readonly unknown[]) => readonly unknown[]) =>
    Effect.gen(function* () {
      const [next, wrote] = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* read;
          // Keep rules from newer clients opaque so editing another binding cannot erase them.
          const rules = mutate(current.rules);
          const value = yield* encodeRules(rules).pipe(Effect.orDie);
          const previous = yield* encodeRules(current.rules).pipe(Effect.orDie);
          if (value === previous) return [resolved(current), false] as const;
          const revision = current.revision + 1;
          yield* sql`INSERT INTO user_keybindings (id, revision, value) VALUES (1, ${revision}, ${value})
        ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, value = excluded.value`;
          return [resolved({ revision, rules }), true] as const;
        }),
      );
      if (wrote) yield* PubSub.publish(changed, undefined);
      return next;
    });
  const upsert: UserKeybindings["Service"]["upsert"] = (input) => {
    const rule: KeybindingRule = {
      key: input.key,
      command: input.command,
      ...(input.when === undefined ? {} : { when: input.when }),
    };
    if (compileResolvedKeybindingRule(rule) === null)
      return Effect.fail(
        new KeybindingsConfigError({
          configPath: "cloud keybindings",
          detail: "Invalid shortcut or condition.",
        }),
      );
    return update((rules) =>
      [
        ...rules.filter(
          (entry) =>
            !matches(entry, rule) &&
            (input.replace === undefined || !matches(entry, input.replace)),
        ),
        rule,
      ].slice(-MAX_KEYBINDINGS_COUNT),
    );
  };
  const remove: UserKeybindings["Service"]["remove"] = (input) =>
    update((rules) => rules.filter((entry) => !matches(entry, input)));
  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changed);
      const first = yield* snapshot;
      return Stream.fromSubscription(subscription).pipe(
        Stream.mapEffect(() => snapshot),
        Stream.prepend([first]),
      );
    }),
  );
  return UserKeybindings.of({ snapshot, changes, upsert, remove });
});

export const layer = Layer.effect(UserKeybindings, make);
