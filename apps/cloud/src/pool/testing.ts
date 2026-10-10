import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Platform from "../platform.ts";
import * as PoolContainer from "./PoolContainer.ts";
import * as PoolDirectory from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import { makePoolObjectApi } from "./poolObjectApi.ts";
import * as PoolStore from "./poolStore.ts";

/**
 * Test doubles for pools: a CLIProxyAPI that answers the management calls a
 * pool makes from memory, and pool objects on in-memory SQLite with it as
 * their container.
 */

interface FakeAccount {
  readonly type: string;
  readonly email: string;
  disabled: boolean;
}

/**
 * The management API of a CLIProxyAPI. A login finishes when its redirect is
 * pasted back (`oauth-callback`), adding `<provider>-<n>@example.test`. Model
 * requests echo what they got.
 */
export const makeFakeCliProxyApi = () => {
  const accounts = new Map<string, FakeAccount>();
  const logins = new Map<string, { readonly type: string; done: boolean }>();
  let counter = 0;
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") return json({ data: [] });
    // A model request: says what it got, so tests can check what the pool sent.
    if (url.pathname.startsWith("/v1/")) {
      return json({
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        body: await request.text(),
      });
    }
    const route = url.pathname.replace(/^\/v0\/management\//u, "");
    if (request.headers.get("authorization") === "Bearer wrong") return json({}, 401);
    switch (`${request.method} ${route}`) {
      case "GET config":
        return json({});
      case "GET anthropic-auth-url":
      case "GET codex-auth-url": {
        counter += 1;
        const state = `state-${counter}`;
        logins.set(state, { type: route.startsWith("codex") ? "codex" : "claude", done: false });
        return json({ url: `https://login.example.test/?state=${state}`, state });
      }
      case "GET get-auth-status": {
        const login = logins.get(url.searchParams.get("state") ?? "");
        if (!login) return json({ status: "error", error: "unknown state" });
        return json({ status: login.done ? "ok" : "wait" });
      }
      case "POST oauth-callback": {
        const body = (await request.json()) as { readonly redirect_url: string };
        const state = new URL(body.redirect_url).searchParams.get("state") ?? "";
        const login = logins.get(state);
        if (!login) return json({ status: "error" }, 404);
        login.done = true;
        counter += 1;
        const email = `${login.type}-${counter}@example.test`;
        accounts.set(`${login.type}-${email}.json`, { type: login.type, email, disabled: false });
        return json({ status: "ok" });
      }
      case "DELETE oauth-session":
        logins.delete(url.searchParams.get("state") ?? "");
        return json({ status: "ok" });
      case "GET auth-files":
        return json({
          files: [...accounts].map(([name, account]) => ({ name, ...account })),
        });
      case "PATCH auth-files/status": {
        const body = (await request.json()) as {
          readonly name: string;
          readonly disabled: boolean;
        };
        const account = accounts.get(body.name);
        if (!account) return json({}, 404);
        account.disabled = body.disabled;
        return json({ status: "ok" });
      }
      case "DELETE auth-files":
        return json({}, accounts.delete(url.searchParams.get("name") ?? "") ? 200 : 404);
      default:
        return json({ error: `no route ${request.method} ${route}` }, 404);
    }
  };
  return { serve, accounts };
};

/**
 * One pool object on in-memory SQLite, its container running a fake
 * CLIProxyAPI. `external` answers for any CLIProxyAPI an admin connects.
 */
export const makeMemoryPoolObject = (
  external: (request: Request) => Promise<Response> = () =>
    Promise.reject(new Error("No external CLIProxyAPI in this test")),
) => {
  const cliProxyApi = makeFakeCliProxyApi();
  const container = PoolContainer.makeFake((request) => cliProxyApi.serve(request));
  const runtime = ManagedRuntime.make(
    PoolEngine.layer.pipe(
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
