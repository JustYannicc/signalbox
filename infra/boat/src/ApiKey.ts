import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { scopeList, scopeMismatch } from "./apiKeyScope.ts";
import type { Providers } from "./Providers.ts";
import { redact } from "./secret.ts";

/** A preset bundle of API key actions. */
export type ApiKeyPreset = "read-only" | "full-sandbox" | "ci" | "admin" | (string & {});

export interface ApiKeyProps {
  /**
   * Key name. If omitted, a unique name is generated from the stack, stage,
   * and logical ID. Changing it creates a new key. With a pinned name a
   * replacement revokes the old key before minting the new one.
   */
  name?: string;
  /**
   * Lifetime of the key, e.g. `"90d"`. Boat applies its default (90 days)
   * when omitted and caps it at its maximum (365 days). An expired key is
   * replaced on the next deploy. Changing it creates a new key.
   */
  ttl?: string;
  /** Preset bundle of actions. Changing it creates a new key. */
  preset?: ApiKeyPreset;
  /**
   * Individual actions the key may perform, e.g. `"sandbox.read"`. Changing
   * them creates a new key.
   */
  actions?: string[];
  /** Restrict the key to these sandboxes. Changing them creates a new key. */
  sandboxIds?: string[];
  /**
   * Restrict the key to these environments, by id (e.g. an
   * {@link Environment}'s `environmentId`). Changing them creates a new key.
   */
  environmentIds?: string[];
  /**
   * Version of the key's secret. Raising it rotates the secret: same key,
   * scope and expiry, new value. Nothing else ever rotates it, so a key
   * Alchemy adopted keeps working for whoever already holds its secret.
   * @default 1
   */
  secretVersion?: number;
}

export interface ApiKeyAttributes {
  /** API key id, e.g. `sak_123`. */
  apiKeyId: string;
  /** Key name. */
  name: string;
  /** Visible prefix of the key, e.g. `boat_live`. */
  keyPrefix: string;
  /** Last four characters of the key. */
  keyLastFour: string;
  /** When the key expires (ISO 8601), if it does. */
  expiresAt: string | undefined;
  /** The actions the key may perform. */
  actions: string[];
  /** Sandboxes the key is limited to, or `"*"` for all of them. */
  sandboxIds: string[] | "*" | undefined;
  /** Environments the key is limited to, or `"*"` for all of them. */
  environmentIds: string[] | "*" | undefined;
  /**
   * The raw key, sent as `Authorization: Bearer <secret>`. Boat shows it
   * only at creation and rotation, so it is `undefined` for a key Alchemy
   * adopted (or whose create response was lost) until `secretVersion` is
   * raised.
   */
  secret: Redacted.Redacted<string> | undefined;
  /** The secret version the key was last reconciled to. */
  secretVersion: number;
}

export type ApiKey = Resource<"Boat.ApiKey", ApiKeyProps, ApiKeyAttributes, never, Providers>;

/**
 * A scoped, expiring Boat API key. Hand one to a worker or CI job so it can
 * only do what it needs.
 *
 * Boat shows the key only once, so Alchemy keeps it in state as a
 * `Redacted` value. Adopting a key never rotates it: its `secret` stays
 * `undefined` until you raise `secretVersion`. Keys are immutable, so a
 * change to the name, TTL, preset, actions or restrictions, or a key that
 * has expired, shows up in the plan as a replacement: a new key is minted
 * and the old one revoked. Creating scoped keys needs an unrestricted
 * account key or one with the `admin` preset.
 * @see https://docs.boat.dev/api/v1
 *
 * @resource
 * @product API Key
 */
export const ApiKey = Resource<ApiKey>("Boat.ApiKey");

const keyName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64 });

/** The key expired, so it can't be used or rotated; the next plan replaces it. */
export class ApiKeyExpired extends Data.TaggedError("ApiKeyExpired")<{
  message: string;
}> {}

const listKeys = boat.listApiKeys({}).pipe(Effect.map((res) => res.apiKeys));

const toAttrs = (
  key: boat.ApiKey,
  secret: Redacted.Redacted<string> | undefined,
  secretVersion: number,
): ApiKeyAttributes => ({
  apiKeyId: key.id,
  name: key.name,
  keyPrefix: key.keyPrefix,
  keyLastFour: key.keyLastFour,
  expiresAt: key.expiresAt ?? key.scope?.expiresAt ?? undefined,
  actions: [...(key.scope?.actions ?? [])].sort(),
  sandboxIds: scopeList(key.scope?.sandboxes),
  environmentIds: scopeList(key.scope?.environments),
  secret,
  secretVersion,
});

const isExpired = (expiresAt: string | undefined) =>
  Option.match(Option.flatMap(Option.fromUndefinedOr(expiresAt), DateTime.make), {
    onNone: () => Effect.succeed(false),
    onSome: DateTime.isPast,
  });

const revoke = (apiKeyId: string) =>
  boat
    .revokeApiKey({ apiKeyId })
    .pipe(Effect.asVoid, Effect.catchTags({ NotFound: () => Effect.void }));

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.succeed({
      stables: ["apiKeyId", "name", "keyPrefix"],
      diff: Effect.fn(function* ({ id, olds, news, output }) {
        if (!isResolved(news)) return undefined;
        const name = output?.name ?? (yield* keyName(id, olds?.name));
        // Boat keys are immutable: any change mints a new one. On adoption
        // `olds` equals `news`, so the observed scope is what's compared.
        if (
          (news.name !== undefined && news.name !== name) ||
          news.ttl !== olds?.ttl ||
          news.preset !== olds?.preset ||
          !deepEqual(news.actions, olds?.actions) ||
          !deepEqual(news.sandboxIds, olds?.sandboxIds) ||
          !deepEqual(news.environmentIds, olds?.environmentIds) ||
          (output !== undefined && scopeMismatch(news, output) !== undefined) ||
          (yield* isExpired(output?.expiresAt))
        ) {
          // Boat doesn't keep names unique, so a pinned name would let the
          // new generation find the old key; revoke the old one first.
          return { action: "replace", deleteFirst: news.name !== undefined } as const;
        }
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const name = output?.name ?? (yield* keyName(id, olds?.name));
        const keys = yield* listKeys;
        // Boat lists keys only to unrestricted callers; a restricted
        // deploy key sees none and has to trust state.
        if (keys.length === 0) return output;
        const key =
          (output && keys.find((k) => k.id === output.apiKeyId)) ??
          keys.find((k) => k.name === name && k.sandboxId === null);
        if (!key) return undefined;
        if (output !== undefined && output.apiKeyId === key.id) {
          return toAttrs(key, output.secret, output.secretVersion);
        }
        // Boat never reveals an existing key's secret.
        const attrs = toAttrs(key, undefined, 1);
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
        const name = yield* keyName(id, news.name ?? output?.name);
        const desiredVersion = news.secretVersion ?? 1;
        const priorVersion = output?.secretVersion ?? olds?.secretVersion ?? 1;

        // Observe
        const keys = yield* listKeys;
        const key =
          (output && keys.find((k) => k.id === output.apiKeyId)) ??
          keys.find((k) => k.name === name && k.sandboxId === null);
        // A restricted deploy key sees no inventory; trust the key in state.
        const unobservable = keys.length === 0 && output !== undefined;

        if (key?.expired) {
          return yield* new ApiKeyExpired({
            message: `Boat API key ${name} (${key.id}) has expired. Run the plan again: it replaces the key.`,
          });
        }

        const rotate = (apiKeyId: string) =>
          Effect.gen(function* () {
            yield* session.note(`Rotating API key ${name}...`);
            const rotated = yield* boat.rotateApiKey({ apiKeyId });
            return toAttrs(rotated.apiKey, redact(rotated.secret), desiredVersion);
          });

        if (key === undefined) {
          if (unobservable) {
            // Rotate only on an explicit version bump.
            return desiredVersion > priorVersion
              ? yield* rotate(output.apiKeyId)
              : { ...output, secretVersion: Math.max(desiredVersion, priorVersion) };
          }
          // Ensure
          yield* session.note(`Creating API key ${name}...`);
          const created = yield* boat.createScopedApiKey({
            name,
            ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
            ...(news.preset !== undefined ? { preset: news.preset } : {}),
            ...(news.actions !== undefined ? { actions: news.actions } : {}),
            ...(news.sandboxIds !== undefined ? { sandboxIds: news.sandboxIds } : {}),
            ...(news.environmentIds !== undefined ? { environmentIds: news.environmentIds } : {}),
          });
          return toAttrs(created.apiKey, redact(created.secret), desiredVersion);
        }

        // Rotate only on an explicit version bump.
        if (desiredVersion > priorVersion) return yield* rotate(key.id);
        return toAttrs(key, output?.apiKeyId === key.id ? output.secret : undefined, priorVersion);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* revoke(output.apiKeyId);
      }),
      // No `list`: account-wide teardown would revoke the key it runs with.
      nuke: { skip: true },
    }),
  );
