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
import {
  POOL_INSTANCE_KINDS,
  type PoolApiKeyProvider,
  type PoolInstanceKind,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  AccountHubError,
  type ManagementEndpoint,
  normalizeHubUrl,
  send as sendManagement,
} from "./accountHubManagement.ts";
import { fingerprint } from "./hubCredentials.ts";

/** The pool provider kinds whose harnesses run API keys through the hub. */
export type ApiKeyInstanceKind = Extract<
  PoolInstanceKind,
  "claude" | "codex" | "grok" | "antigravity"
>;

/** The hub's key lists, and the pool provider that runs each one's keys. */
const LIST_KIND = {
  "claude-api-key": "claude",
  "codex-api-key": "codex",
  "gemini-api-key": "antigravity",
  "xai-api-key": "grok",
  // Entries carry their own endpoint and models; Codex speaks to any of them.
  "openai-compatibility": "codex",
} as const satisfies Record<string, ApiKeyInstanceKind>;
type ListName = keyof typeof LIST_KIND;
const LISTS = Object.keys(LIST_KIND) as ReadonlyArray<ListName>;

interface Route {
  readonly list: ListName;
  readonly baseUrl?: string;
  readonly label: string;
}

const ROUTES: Record<Exclude<PoolApiKeyProvider, "cursor">, Route> = {
  anthropic: { list: "claude-api-key", label: "Anthropic API key" },
  // The hub sends Codex keys to `<base-url>/responses`, so OpenAI's needs its own base.
  openai: { list: "codex-api-key", baseUrl: "https://api.openai.com/v1", label: "OpenAI API key" },
  xai: { list: "xai-api-key", baseUrl: "https://api.x.ai/v1", label: "xAI API key" },
  gemini: { list: "gemini-api-key", label: "Gemini API key" },
  openrouter: {
    list: "openai-compatibility",
    baseUrl: "https://openrouter.ai/api/v1",
    label: "OpenRouter API key",
  },
  "openai-compatible": { list: "openai-compatibility", label: "API key" },
};

const API_KEY_ID_PREFIX = "api-key:";

/** The stable id of one key in one list, safe to show: it never contains the key. */
export const apiKeyAccountId = (list: ListName, apiKey: string, baseUrl: string | undefined) =>
  `${API_KEY_ID_PREFIX}${list}:${fingerprint(`${apiKey}|${baseUrl ? normalizeHubUrl(baseUrl) : ""}`)}`;

export const isApiKeyAccountId = (id: string) => id.startsWith(API_KEY_ID_PREFIX);

/** The list an account id names, so a key is found by reading that list alone. */
const listOfId = (id: string): ListName | undefined => {
  const list = id.slice(API_KEY_ID_PREFIX.length).split(":")[0];
  return LISTS.find((candidate) => candidate === list);
};

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

const labelFor = (list: ListName, baseUrl: string | undefined) => {
  const base = baseUrl ? normalizeHubUrl(baseUrl) : undefined;
  const route = Object.values(ROUTES).find(
    (candidate) => candidate.list === list && candidate.baseUrl === base,
  );
  if (route) return route.label;
  if (list !== "openai-compatibility" && !base) {
    return Object.values(ROUTES).find((candidate) => candidate.list === list)?.label ?? "API key";
  }
  return base && URL.canParse(base) ? `${new URL(base).host} API key` : "API key";
};

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

/** The keys in one list's raw entries. */
const keysIn = (list: ListName, entries: ReadonlyArray<unknown>): HubApiKey[] => {
  const driver = POOL_INSTANCE_KINDS[LIST_KIND[list]].driver;
  const key = (apiKey: string, baseUrl: string | undefined, entryName: string | undefined) => ({
    id: apiKeyAccountId(list, apiKey, baseUrl),
    driver,
    label: `${labelFor(list, baseUrl)} ${keyHint(apiKey)}`,
    list,
    apiKey,
    baseUrl,
    entryName,
  });
  return list === "openai-compatibility"
    ? entries.flatMap((raw) => {
        const entry = decodeCompatEntry(raw);
        if (entry._tag === "None") return [];
        return (entry.value["api-key-entries"] ?? []).map((apiKey) =>
          key(apiKey["api-key"], entry.value["base-url"], entry.value.name),
        );
      })
    : entries.flatMap((raw) => {
        const entry = decodeKeyEntry(raw);
        return entry._tag === "None"
          ? []
          : [key(entry.value["api-key"], entry.value["base-url"] || undefined, undefined)];
      });
};

/** Every key the hub routes, across its lists. */
export const listApiKeys = Effect.fn("hubApiKeys.list")(function* (endpoint: ManagementEndpoint) {
  const lists = yield* Effect.forEach(
    LISTS,
    (list) => readList(endpoint, list).pipe(Effect.map((entries) => keysIn(list, entries))),
    { concurrency: LISTS.length },
  );
  return lists.flat();
});

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeModelList = Schema.decodeUnknownEffect(ModelList);

/**
 * The models an OpenAI-compatible API serves at `<baseUrl>/models`, sorted and
 * without repeats so two reads compare equal.
 */
export const listModels = (baseUrl: string, apiKey: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${baseUrl}/models`).pipe(HttpClientRequest.bearerToken(apiKey)),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const models = yield* response.json.pipe(Effect.flatMap(decodeModelList));
    return [...new Set(models.data.map((model) => model.id))].toSorted();
  }).pipe(Effect.timeout("15 seconds"));

/**
 * Adds a key to the hub. Returns the pool provider kind that runs it, so the
 * pool can make sure that provider exists. A key already there changes nothing.
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
  const kind = LIST_KIND[route.list];
  const apiKey = input.apiKey.trim();
  const baseUrl = route.baseUrl ?? (input.baseUrl ? normalizeHubUrl(input.baseUrl) : undefined);
  if (route.list === "openai-compatibility" && !baseUrl) {
    return yield* new AccountHubError({ detail: "Enter the endpoint's URL." });
  }
  const entries = yield* readList(endpoint, route.list);
  const id = apiKeyAccountId(route.list, apiKey, baseUrl);
  if (keysIn(route.list, entries).some((key) => key.id === id)) return kind;
  if (route.list === "openai-compatibility" && baseUrl) {
    // The hub routes only the models an entry lists; asking also checks the key works.
    const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
    const models = yield* listModels(baseUrl, apiKey).pipe(
      Effect.mapError(
        (cause) => new AccountHubError({ detail: `${host} did not accept the API key.`, cause }),
      ),
    );
    if (models.length === 0) {
      return yield* new AccountHubError({ detail: `${host} offers no models for that key.` });
    }
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
  return kind;
});

/** Removes one key by its account id. A key that is already gone is not an error. */
export const removeApiKey = Effect.fn("hubApiKeys.remove")(function* (
  endpoint: ManagementEndpoint,
  id: string,
) {
  const list = listOfId(id);
  if (!list) return;
  const key = keysIn(list, yield* readList(endpoint, list)).find(
    (candidate) => candidate.id === id,
  );
  if (!key) return;
  const query =
    list === "openai-compatibility"
      ? `name=${encodeURIComponent(key.entryName ?? "")}`
      : `api-key=${encodeURIComponent(key.apiKey)}&base-url=${encodeURIComponent(key.baseUrl ?? "")}`;
  const response = yield* sendManagement(endpoint, "DELETE", `${list}?${query}`);
  if (response.status !== 200) {
    return yield* new AccountHubError({ detail: "The hub did not remove the API key." });
  }
});

// Root sections the hub keeps API keys in: the v8 `api-keys` map, and the older flat lists.
const API_KEY_SECTIONS = ["api-keys", ...LISTS] as const;

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
