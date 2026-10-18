// @effect-diagnostics globalDate:off - the fake CLIProxyAPI holds accounts on the wall clock, as CLIProxyAPI does.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Platform from "../platform.ts";
import * as PoolContainer from "./PoolContainer.ts";
import * as PoolDirectory from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import * as PoolLinks from "./PoolLinks.ts";
import { makePoolObjectApi } from "./poolObjectApi.ts";
import * as PoolStore from "./poolStore.ts";
import { PoolTelemetry, type PoolCallEvent } from "./PoolTelemetry.ts";

/**
 * Test doubles for pools: a CLIProxyAPI that answers the management calls a
 * pool makes from memory, and pool objects on in-memory SQLite with it as
 * their container.
 */

interface FakeAccount {
  readonly type: string;
  readonly email: string;
  disabled: boolean;
  /** Headers of its last response, as CLIProxyAPI keeps them; none until set. */
  signals?: Record<string, string>;
  /** When those headers came, ISO. */
  observedAt?: string;
  /** What the provider's usage endpoint answers for it; 200 with no windows unless set. */
  usage?: { readonly status: number; readonly body: string };
  /** Until when CLIProxyAPI keeps it cooling down after a 429, ISO; it routes nothing to it. */
  cooldownUntil?: string;
  /** Set through `credentials/fields`: `<prefix>/<model>` routes to this account alone. */
  prefix?: string;
}

interface FakeModel {
  readonly id: string;
  /** Epoch seconds. */
  readonly created: number;
  readonly displayName: string;
  readonly reasoningEfforts: ReadonlyArray<string>;
}

/** What `/v1/models` lists per account type: CLIProxyAPI's catalog, trimmed to what tests need. */
const fakeCatalog = (): Record<string, Array<FakeModel>> => ({
  claude: [
    {
      id: "claude-opus-5-5",
      created: 1_790_035_200,
      displayName: "Claude Opus 5.5",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "claude-sonnet-5-5",
      created: 1_790_553_600,
      displayName: "Claude Sonnet 5.5",
      reasoningEfforts: [],
    },
    {
      id: "claude-fable-5-1",
      created: 1_788_220_800,
      displayName: "Claude Fable 5.1",
      reasoningEfforts: [],
    },
    // Legacy in the model manifest.
    {
      id: "claude-opus-5",
      created: 1_784_038_800,
      displayName: "Claude Opus 5",
      reasoningEfforts: [],
    },
    // Unknown to the manifest, and older than every current model.
    {
      id: "claude-3-7-sonnet-20250219",
      created: 1_708_300_800,
      displayName: "Claude 3.7 Sonnet",
      reasoningEfforts: [],
    },
  ],
  codex: [
    {
      id: "gpt-6-astra",
      created: 1_783_616_400,
      displayName: "GPT-6 Astra",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6.1-sol",
      created: 1_790_640_000,
      displayName: "GPT-6.1 Sol",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "gpt-6-luna",
      created: 1_790_035_200,
      displayName: "GPT-6 Luna",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "gpt-5.5",
      created: 1_776_902_400,
      displayName: "GPT-5.5",
      reasoningEfforts: [],
    },
  ],
});

/** CLIProxyAPI's `owned_by` per account type. */
const OWNER_BY_TYPE: Record<string, string> = { claude: "anthropic", codex: "openai" };

/**
 * The v8 management API of a CLIProxyAPI; anything else under a management
 * path is a 404. A login finishes when its redirect is pasted back
 * (`oauth/callback`), adding `<provider>-<n>@example.test`. `configPatches`
 * records each config change.
 * `/v1/models` lists `catalog`'s models for the types of its enabled
 * accounts, as CLIProxyAPI registers models per loaded account, and each
 * model again under every account's prefix. Other model requests echo what
 * they got. They go round robin over the accounts that aren't paused or
 * cooling down, or to the one account a prefixed model names, and say which
 * in `X-CPA-TRACE-ID` (its `auth_index`) and `X-Fake-Account` (its name).
 */
export const makeFakeCliProxyApi = () => {
  const accounts = new Map<string, FakeAccount>();
  const catalog = fakeCatalog();
  const logins = new Map<
    string,
    { readonly type: string; readonly userCode?: string; saving?: boolean; done: boolean }
  >();
  const finishLogin = (state: string) => {
    const login = logins.get(state);
    if (!login || login.done) return false;
    login.done = true;
    counter += 1;
    const email = `${login.type}-${counter}@example.test`;
    accounts.set(`${login.type}-${email}.json`, { type: login.type, email, disabled: false });
    return true;
  };
  const configPatches: Array<unknown> = [];
  /** The upstream URLs asked as each account (`requests/api-call`), by account name. */
  const accountRequests: Array<{ readonly name: string; readonly url: string }> = [];
  // Hex, as CLIProxyAPI's are: `X-CPA-TRACE-ID` separates its parts with dashes.
  const authIndex = (name: string) =>
    [...name]
      .reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261)
      .toString(16)
      .padStart(8, "0");
  /** Accounts whose cooldown was cleared (`routing/cooldown/reset`), in order. */
  const cooldownResets: Array<string> = [];
  /** Provider channels whose optional model definitions were read. */
  const modelDefinitionRequests: Array<string> = [];
  const cooling = (account: FakeAccount) =>
    account.cooldownUntil !== undefined && Date.parse(account.cooldownUntil) > Date.now();
  let counter = 0;
  let deviceExpiresIn = 900;
  let turn = 0;
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const modelError = (status: number, message: string) =>
    json({ type: "error", error: { type: "api_error", message } }, status);
  const modelOf = (body: string) => {
    try {
      const model: unknown = (JSON.parse(body) as { readonly model?: unknown }).model;
      return typeof model === "string" ? model : null;
    } catch {
      return null;
    }
  };

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") {
      const types = new Set(
        [...accounts.values()].filter((account) => !account.disabled).map((a) => a.type),
      );
      const listed = (type: string, prefix?: string) =>
        (catalog[type] ?? []).map((model) => ({
          id: prefix === undefined ? model.id : `${prefix}/${model.id}`,
          object: "model",
          created: model.created,
          owned_by: OWNER_BY_TYPE[type] ?? type,
        }));
      const prefixed = [...accounts.values()].flatMap((account) =>
        account.disabled || account.prefix === undefined
          ? []
          : listed(account.type, account.prefix),
      );
      return json({
        object: "list",
        data: [...[...types].flatMap((type) => listed(type)), ...prefixed],
      });
    }
    // A model request: says what it got, so tests can check what the pool sent.
    if (url.pathname.startsWith("/v1/")) {
      const usable = [...accounts.values()].filter((account) => !account.disabled);
      // Every account cooling down: answered here, without asking the provider.
      if (usable.length > 0 && usable.every(cooling)) {
        return json(
          {
            error: {
              code: "model_cooldown",
              message: "All credentials for model claude-opus-5-5 are cooling down",
            },
          },
          429,
        );
      }
      const body = await request.text();
      const model = modelOf(body);
      const slash = model?.indexOf("/") ?? -1;
      let served: readonly [string, FakeAccount] | undefined;
      if (model !== null && slash > 0) {
        served = [...accounts].find(([, account]) => account.prefix === model.slice(0, slash));
        if (served === undefined) return modelError(400, `unknown provider for model ${model}`);
        if (served[1].disabled) return modelError(503, "auth_unavailable: no auth available");
        if (cooling(served[1])) {
          return modelError(429, `All credentials for model ${model} are cooling down`);
        }
      } else {
        const ready = [...accounts].filter(([, account]) => !account.disabled && !cooling(account));
        served = ready[turn++ % Math.max(ready.length, 1)];
      }
      const headers = new Headers();
      if (served !== undefined) {
        headers.set("x-cpa-trace-id", `20261015120000-${authIndex(served[0])}-req-${turn}`);
        headers.set("x-fake-account", served[0]);
      }
      return Response.json(
        {
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          body,
        },
        { headers },
      );
    }
    if (!url.pathname.startsWith("/v8/management/")) {
      return json({ error: `no route ${request.method} ${url.pathname}` }, 404);
    }
    const route = url.pathname.slice("/v8/management/".length);
    if (request.headers.get("authorization") === "Bearer wrong") return json({}, 401);
    const modelDefinitions = /^routing\/model-definitions\/(claude|codex)$/u.exec(route);
    if (request.method === "GET" && modelDefinitions !== null) {
      const channel = modelDefinitions[1] as "claude" | "codex";
      modelDefinitionRequests.push(channel);
      return json({
        channel,
        models: (catalog[channel] ?? []).map((model) => ({
          id: model.id,
          display_name: model.displayName,
          type: channel,
          owned_by: OWNER_BY_TYPE[channel],
          thinking: { levels: model.reasoningEfforts },
        })),
      });
    }
    switch (`${request.method} ${route}`) {
      case "GET config":
        return json({});
      case "PATCH config":
        configPatches.push(await request.json());
        return json({});
      case "GET oauth/auth-url": {
        const provider = url.searchParams.get("provider");
        if (provider !== "claude" && provider !== "codex") return json({}, 404);
        counter += 1;
        const state = `state-${counter}`;
        if (provider === "codex" && url.searchParams.get("flow") === "device") {
          const userCode = `TEST-${counter}`;
          logins.set(state, { type: provider, userCode, done: false });
          return json({
            url: "https://auth.openai.com/codex/device",
            state,
            user_code: userCode,
            expires_in: deviceExpiresIn,
          });
        }
        logins.set(state, { type: provider, done: false });
        const manual = provider === "claude" && url.searchParams.get("flow") === "manual";
        // Each provider's browser flow ends on its CLIProxyAPI listener; Claude manual mode
        // returns a code directly instead of pretending the hosted callback reached this server.
        const redirect = manual
          ? "https://platform.claude.com/oauth/code/callback"
          : provider === "claude"
            ? "http://localhost:54545/callback"
            : "http://localhost:1455/auth/callback";
        const login = new URL("https://login.example.test/");
        login.searchParams.set("redirect_uri", redirect);
        login.searchParams.set("state", state);
        return json({
          url: login.toString(),
          state,
          ...(manual ? { flow: "manual" } : {}),
        });
      }
      case "GET oauth/status": {
        const login = logins.get(url.searchParams.get("state") ?? "");
        if (!login) return json({ status: "error", error: "unknown state" });
        return json({ status: login.done ? "ok" : "wait" });
      }
      case "POST oauth/callback": {
        const body = (await request.json()) as {
          readonly redirect_url?: string;
          readonly state?: string;
          readonly code?: string;
        };
        const state = body.redirect_url
          ? (new URL(body.redirect_url).searchParams.get("state") ?? "")
          : (body.state ?? "");
        const login = logins.get(state);
        if (!login) return json({ status: "error" }, 404);
        if (login.userCode !== undefined || (!body.redirect_url && !body.code)) {
          return json({ status: "error" }, 400);
        }
        finishLogin(state);
        return json({ status: "ok" });
      }
      case "DELETE oauth/session": {
        const state = url.searchParams.get("state") ?? "";
        const login = logins.get(state);
        if (login?.saving) return json({ cancelled: false });
        return json({ cancelled: logins.delete(state) });
      }
      case "GET credentials":
        return json({
          files: [...accounts].map(([name, account]) => ({
            name,
            auth_index: authIndex(name),
            type: account.type,
            email: account.email,
            disabled: account.disabled,
            quota: {
              signals: account.signals ?? {},
              ...(account.observedAt ? { observed_at: account.observedAt } : {}),
            },
            cooldowns: cooling(account)
              ? [
                  {
                    scope: "credential",
                    reason: "credential_quota",
                    retry_at: account.cooldownUntil,
                    remaining_seconds: Math.round(
                      (Date.parse(account.cooldownUntil!) - Date.now()) / 1000,
                    ),
                    http_status: 429,
                  },
                ]
              : [],
          })),
        });
      case "POST routing/cooldown/reset": {
        const body = (await request.json()) as { readonly auth_index: string };
        const found = [...accounts].find(([name]) => authIndex(name) === body.auth_index);
        if (!found) return json({ error: "auth not found" }, 404);
        delete found[1].cooldownUntil;
        cooldownResets.push(found[0]);
        return json({ status: "ok", auth_index: body.auth_index });
      }
      case "POST requests/api-call": {
        const body = (await request.json()) as {
          readonly auth_index: string;
          readonly url: string;
        };
        const found = [...accounts].find(([name]) => authIndex(name) === body.auth_index);
        if (!found) return json({ error: "auth not found" }, 404);
        accountRequests.push({ name: found[0], url: body.url });
        const usage = found[1].usage ?? { status: 200, body: "{}" };
        return json({ status_code: usage.status, body: usage.body });
      }
      case "PATCH credentials/fields": {
        const body = (await request.json()) as { readonly name: string; readonly prefix?: string };
        const account = accounts.get(body.name);
        if (!account) return json({ error: "auth file not found" }, 404);
        // An empty prefix removes it.
        if (body.prefix === "") delete account.prefix;
        else if (body.prefix !== undefined) account.prefix = body.prefix;
        return json({ status: "ok" });
      }
      case "PATCH credentials/status": {
        const body = (await request.json()) as {
          readonly name: string;
          readonly disabled: boolean;
        };
        const account = accounts.get(body.name);
        if (!account) return json({}, 404);
        account.disabled = body.disabled;
        return json({ status: "ok" });
      }
      case "POST credentials": {
        const name = url.searchParams.get("name") ?? "";
        const body = (await request.json()) as { readonly type: string; readonly email?: string };
        if (body.email === "refused@example.test") return json({}, 500);
        accounts.set(name, { type: body.type, email: body.email ?? name, disabled: false });
        return json({ status: "ok" });
      }
      case "DELETE credentials":
        return json({}, accounts.delete(url.searchParams.get("name") ?? "") ? 200 : 404);
      default:
        return json({ error: `no route ${request.method} ${route}` }, 404);
    }
  };
  return {
    serve,
    accounts,
    catalog,
    configPatches,
    accountRequests,
    cooldownResets,
    modelDefinitionRequests,
    authorizeDevice: (userCode: string) => {
      const found = [...logins].find(([, login]) => login.userCode === userCode);
      return found !== undefined && finishLogin(found[0]);
    },
    beginLoginSave: (userCode: string) => {
      const found = [...logins.values()].find((login) => login.userCode === userCode);
      if (!found || found.done) return false;
      found.saving = true;
      return true;
    },
    setDeviceExpiresIn: (seconds: number) => {
      deviceExpiresIn = seconds;
    },
  };
};

/**
 * One pool object on in-memory SQLite, its container running a fake
 * CLIProxyAPI. `external` answers for any CLIProxyAPI an admin connects.
 */
export const makeMemoryPoolObject = (
  external: (request: Request) => Promise<Response> = () =>
    Promise.reject(new Error("No external CLIProxyAPI in this test")),
  submit: (event: PoolCallEvent) => void = () => {},
) => {
  const cliProxyApi = makeFakeCliProxyApi();
  const container = PoolContainer.makeFake((request) => cliProxyApi.serve(request));
  const runtime = ManagedRuntime.make(
    PoolEngine.layer.pipe(
      Layer.provideMerge(PoolLinks.layer),
      Layer.provideMerge(container.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          PoolStore.layer,
          Layer.succeed(PoolEngine.ExternalFetch, PoolEngine.ExternalFetch.of({ fetch: external })),
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
      ),
      Layer.provideMerge(Layer.succeed(PoolTelemetry, { submit })),
    ),
  );
  let erased = false;
  const api = makePoolObjectApi(
    async (effect) => {
      await runtime.runPromise(PoolEngine.PoolEngine.use((engine) => engine.initialize));
      return runtime.runPromise(effect);
    },
    async () => {
      erased = true;
    },
  );
  return { api, runtime, cliProxyApi, container: container.state, erased: () => erased };
};

/** Pool objects by name, created on first use, as `PoolDirectory` reaches them. */
export const makeMemoryPools = (external?: (request: Request) => Promise<Response>) => {
  const objects = new Map<string, ReturnType<typeof makeMemoryPoolObject>>();
  const objectFor = (name: string) => {
    const existing = objects.get(name);
    if (existing && !existing.erased()) return existing;
    const created = makeMemoryPoolObject(external);
    objects.set(name, created);
    return created;
  };
  const directory = PoolDirectory.PoolDirectory.of({
    forPool: (name) => PoolDirectory.handleFor(objectFor(name).api),
  });
  return { directory, objectFor, objects };
};
