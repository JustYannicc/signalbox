/**
 * API keys in a pool's hub. CLIProxyAPI keeps them in its config, not as
 * credential files, and routes them like the subscription logins of the same
 * provider: a Claude API key and a Claude login in one pool take turns in
 * rotation. Both backings are written through the management API, so a key
 * lands the same way in Signalbox's own hub and in one the user runs.
 *
 * Signalbox rewrites its own hub's config on every start, so the key sections
 * the hub saved are carried over (`apiKeySections`).
 *
 * @module accountHub/hubApiKeys
 */
import * as NodeCrypto from "node:crypto";

import type { PoolApiKeyProvider } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  AccountHubError,
  type ManagementEndpoint,
  send as sendManagement,
} from "./accountHubManagement.ts";

/** The hub's key lists. `openai-compatibility` entries carry their own endpoint and models. */
type KeyList = "claude-api-key" | "codex-api-key" | "gemini-api-key" | "xai-api-key";
type ListName = KeyList | "openai-compatibility";

/** The pool provider kind (`poolInstanceId`) whose harness uses each key. */
export type ApiKeyInstanceKind = "claude" | "codex" | "grok" | "antigravity";

interface Route {
  readonly list: ListName;
  readonly baseUrl?: string;
  readonly kind: ApiKeyInstanceKind;
  readonly label: string;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1";

const ROUTES: Record<Exclude<PoolApiKeyProvider, "cursor">, Route> = {
  anthropic: { list: "claude-api-key", kind: "claude", label: "Anthropic API key" },
  // The hub sends Codex keys to `<base-url>/responses`, so OpenAI's needs its own base.
  openai: {
    list: "codex-api-key",
    baseUrl: "https://api.openai.com/v1",
    kind: "codex",
    label: "OpenAI API key",
  },
  xai: { list: "xai-api-key", baseUrl: "https://api.x.ai/v1", kind: "grok", label: "xAI API key" },
  gemini: { list: "gemini-api-key", kind: "antigravity", label: "Gemini API key" },
  openrouter: {
    list: "openai-compatibility",
    baseUrl: OPENROUTER_URL,
    kind: "codex",
    label: "OpenRouter API key",
  },
  "openai-compatible": { list: "openai-compatibility", kind: "codex", label: "API key" },
};

const DRIVER_BY_KIND: Record<ApiKeyInstanceKind, string> = {
  claude: "claudeAgent",
  codex: "codex",
  grok: "grok",
  antigravity: "antigravity",
};

export const apiKeyRoute = (provider: Exclude<PoolApiKeyProvider, "cursor">) => ROUTES[provider];

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/u, "");

const fingerprint = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

const API_KEY_ID_PREFIX = "api-key:";

/** The stable id of one key in one list, safe to show: it never contains the key. */
export const apiKeyAccountId = (list: ListName, apiKey: string, baseUrl: string | undefined) =>
  `${API_KEY_ID_PREFIX}${list}:${fingerprint(`${apiKey}|${baseUrl ? normalizeUrl(baseUrl) : ""}`)}`;

export const isApiKeyAccountId = (id: string) => id.startsWith(API_KEY_ID_PREFIX);

/** `····abcd`, so an admin can tell two keys apart without seeing either. */
const keyHint = (apiKey: string) => `····${apiKey.slice(-4)}`;

const KeyEntry = Schema.Struct({
  "api-key": Schema.String,
  "base-url": Schema.optional(Schema.String),
});
const CompatEntry = Schema.Struct({
  name: Schema.String,
  "base-url": Schema.optional(Schema.String),
  "api-key-entries": Schema.optional(Schema.Array(Schema.Struct({ "api-key": Schema.String }))),
});
const decodeKeyEntry = Schema.decodeUnknownOption(KeyEntry);
const isAccountHubError = Schema.is(AccountHubError);
const decodeCompatEntry = Schema.decodeUnknownOption(CompatEntry);

/** One key as the pool's admins see it. */
export interface HubApiKey {
  readonly id: string;
  readonly driver: string;
  readonly label: string;
  readonly list: ListName;
  readonly apiKey: string;
  readonly baseUrl: string | undefined;
  /** For `openai-compatibility` entries, the entry that holds the key. */
  readonly entryName: string | undefined;
}

const KEY_LISTS: ReadonlyArray<KeyList> = [
  "claude-api-key",
  "codex-api-key",
  "gemini-api-key",
  "xai-api-key",
];

const labelFor = (list: ListName, baseUrl: string | undefined) => {
  const base = baseUrl ? normalizeUrl(baseUrl) : undefined;
  const route = Object.values(ROUTES).find(
    (candidate) =>
      candidate.list === list && (candidate.baseUrl === undefined || candidate.baseUrl === base),
  );
  if (route && (route.baseUrl !== undefined || list !== "openai-compatibility")) {
    return route.label;
  }
  return base && URL.canParse(base) ? `${new URL(base).host} API key` : "API key";
};

const kindForList = (list: ListName): ApiKeyInstanceKind =>
  list === "claude-api-key"
    ? "claude"
    : list === "xai-api-key"
      ? "grok"
      : list === "gemini-api-key"
        ? "antigravity"
        : "codex";

/** One raw list. A hub that does not know the list (older versions) has no keys in it. */
const readList = (endpoint: ManagementEndpoint, list: ListName) =>
  sendManagement(endpoint, "GET", list).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json.pipe(
            Effect.map((json): ReadonlyArray<unknown> => {
              const value =
                json !== null && typeof json === "object"
                  ? (json as Record<string, unknown>)[list]
                  : undefined;
              return Array.isArray(value) ? value : [];
            }),
            Effect.orElseSucceed((): ReadonlyArray<unknown> => []),
          )
        : Effect.succeed<ReadonlyArray<unknown>>([]),
    ),
  );

const writeList = (endpoint: ManagementEndpoint, list: ListName, entries: ReadonlyArray<unknown>) =>
  sendManagement(endpoint, "PUT", list, (request) =>
    HttpClientRequest.bodyJsonUnsafe(request, entries),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.void
        : Effect.fail(new AccountHubError({ detail: "The hub did not save the API key." })),
    ),
  );

/** Every key the hub routes, across its lists. */
export const listApiKeys = Effect.fn("hubApiKeys.list")(function* (endpoint: ManagementEndpoint) {
  const lists = yield* Effect.forEach(
    [...KEY_LISTS, "openai-compatibility" as const],
    (list) => readList(endpoint, list).pipe(Effect.map((entries) => [list, entries] as const)),
    { concurrency: 5 },
  );
  return lists.flatMap(([list, entries]): HubApiKey[] =>
    list === "openai-compatibility"
      ? entries.flatMap((raw) => {
          const entry = decodeCompatEntry(raw);
          if (entry._tag === "None") return [];
          const baseUrl = entry.value["base-url"];
          return (entry.value["api-key-entries"] ?? []).map((key) => ({
            id: apiKeyAccountId(list, key["api-key"], baseUrl),
            driver: DRIVER_BY_KIND[kindForList(list)],
            label: `${labelFor(list, baseUrl)} ${keyHint(key["api-key"])}`,
            list,
            apiKey: key["api-key"],
            baseUrl,
            entryName: entry.value.name,
          }));
        })
      : entries.flatMap((raw) => {
          const entry = decodeKeyEntry(raw);
          if (entry._tag === "None") return [];
          const baseUrl = entry.value["base-url"] || undefined;
          return [
            {
              id: apiKeyAccountId(list, entry.value["api-key"], baseUrl),
              driver: DRIVER_BY_KIND[kindForList(list)],
              label: `${labelFor(list, baseUrl)} ${keyHint(entry.value["api-key"])}`,
              list,
              apiKey: entry.value["api-key"],
              baseUrl,
              entryName: undefined,
            },
          ];
        }),
  );
});

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeModelList = Schema.decodeUnknownEffect(ModelList);

/**
 * The models an OpenAI-compatible endpoint serves. The hub only routes models
 * an entry lists, and asking also checks the key works.
 */
const compatibleModels = Effect.fn("hubApiKeys.compatibleModels")(function* (
  baseUrl: string,
  apiKey: string,
) {
  const http = yield* HttpClient.HttpClient;
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
  const failed = (detail: string) => (cause: unknown) => new AccountHubError({ detail, cause });
  const response = yield* http
    .execute(HttpClientRequest.get(`${baseUrl}/models`).pipe(HttpClientRequest.bearerToken(apiKey)))
    .pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(failed(`Could not reach ${host}.`)),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((cause) =>
        isAccountHubError(cause)
          ? cause
          : new AccountHubError({ detail: `${host} did not accept the API key.`, cause }),
      ),
    );
  const models = yield* response.json.pipe(
    Effect.flatMap(decodeModelList),
    Effect.mapError(failed(`${host} did not list its models like an OpenAI-compatible API.`)),
  );
  if (models.data.length === 0) {
    return yield* new AccountHubError({ detail: `${host} offers no models for that key.` });
  }
  return models.data.map((model) => model.id);
});

/**
 * Adds a key to the hub. Returns the pool provider kind that runs it, so the
 * pool can make sure that provider exists.
 */
export const addApiKey = Effect.fn("hubApiKeys.add")(function* (
  endpoint: ManagementEndpoint,
  input: {
    readonly provider: Exclude<PoolApiKeyProvider, "cursor">;
    readonly apiKey: string;
    readonly baseUrl?: string | undefined;
  },
) {
  const route = ROUTES[input.provider];
  const apiKey = input.apiKey.trim();
  const baseUrl = route.baseUrl ?? (input.baseUrl ? normalizeUrl(input.baseUrl) : undefined);
  if (route.list === "openai-compatibility" && !baseUrl) {
    return yield* new AccountHubError({ detail: "Enter the endpoint's URL." });
  }
  const id = apiKeyAccountId(route.list, apiKey, baseUrl);
  // Already there: adding it again changes nothing.
  if ((yield* listApiKeys(endpoint)).some((key) => key.id === id)) return route.kind;
  const entries = yield* readList(endpoint, route.list);
  if (route.list === "openai-compatibility" && baseUrl) {
    const models = yield* compatibleModels(baseUrl, apiKey);
    yield* writeList(endpoint, route.list, [
      ...entries,
      {
        name: `${input.provider}-${fingerprint(apiKey)}`,
        "base-url": baseUrl,
        "api-key-entries": [{ "api-key": apiKey }],
        models: models.map((model) => ({ name: model, alias: model })),
      },
    ]);
  } else {
    yield* writeList(endpoint, route.list, [
      ...entries,
      { "api-key": apiKey, ...(baseUrl ? { "base-url": baseUrl } : {}) },
    ]);
  }
  return route.kind;
});

/** Removes one key by its account id. A key that is already gone is not an error. */
export const removeApiKey = Effect.fn("hubApiKeys.remove")(function* (
  endpoint: ManagementEndpoint,
  id: string,
) {
  const key = (yield* listApiKeys(endpoint)).find((candidate) => candidate.id === id);
  if (!key) return;
  const query =
    key.list === "openai-compatibility"
      ? `name=${encodeURIComponent(key.entryName ?? "")}`
      : `api-key=${encodeURIComponent(key.apiKey)}&base-url=${encodeURIComponent(key.baseUrl ?? "")}`;
  const response = yield* sendManagement(endpoint, "DELETE", `${key.list}?${query}`);
  if (response.status !== 200) {
    return yield* new AccountHubError({ detail: "The hub did not remove the API key." });
  }
});

// Root sections the hub keeps API keys in: the v8 `api-keys` map, and the older flat lists.
const API_KEY_SECTIONS = [
  "api-keys",
  "claude-api-key",
  "codex-api-key",
  "gemini-api-key",
  "xai-api-key",
  "openai-compatibility",
] as const;

/**
 * The API-key sections of a hub config the hub wrote, as YAML to append to a
 * freshly rendered config. Root `api-keys` only holds upstream keys when it is
 * a map (v8); a list there would be old-style client keys, which are dropped.
 */
export function apiKeySections(configText: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(configText);
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const config = parsed as Record<string, unknown>;
  const kept = Object.fromEntries(
    API_KEY_SECTIONS.flatMap((section) => {
      const value = config[section];
      if (value === null || value === undefined) return [];
      if (section === "api-keys" && (typeof value !== "object" || Array.isArray(value))) return [];
      return [[section, value]];
    }),
  );
  return Object.keys(kept).length > 0 ? stringifyYaml(kept) : "";
}
