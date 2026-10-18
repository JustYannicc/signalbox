// @effect-diagnostics nodeBuiltinImport:off -- The workerd harness bundles a filesystem entry point.
import * as NodeURL from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { createTestHarness } from "wrangler";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";
import type { DurableObjectNamespace as HarnessNamespace } from "@cloudflare/workers-types";

import { catalogHomes } from "./CatalogHomes.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import type { CatalogObjectEnv } from "./catalogObjects.ts";
import { CatalogPersonalRoot } from "./catalogPolicy.ts";
import { openCatalogSocket } from "./tests/catalogSocket.ts";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "catalog-runtime-test",
        main: NodeURL.fileURLToPath(new URL("./tests/catalogRuntime.fixture.ts", import.meta.url)),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          LOCAL_WORKERD: "1",
          LUNORA_RELAY_SECRET: "isolated-catalog-runtime-test",
          T3CODE_TELEMETRY_ENABLED: "0",
        },
        durable_objects: {
          bindings: [
            { name: "HOMES", class_name: "HomeObject" },
            { name: "CATALOG_SCHEDULER", class_name: "CatalogScheduler" },
          ],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["HomeObject", "CatalogScheduler"] }],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

const decodePersonalRoot = Schema.decodeUnknownSync(CatalogPersonalRoot);
const homeFor = (personId: string) =>
  decodePersonalRoot({
    owner: { _tag: "person", id: personId },
    level: { _tag: "top" },
  });
const root = { folderId: null, incarnation: 1 };
const query = { name: "access", input: root } as const;
type TestEnv = CatalogObjectEnv;
interface HarnessEnv {
  readonly HOMES: HarnessNamespace;
}
const workerFor = () => harness.getWorker<HarnessEnv>();
const environment = async () => (await workerFor().getEnv()) as unknown as TestEnv;
const requestHome = (env: TestEnv, homeKey: string, path: string, method = "GET") =>
  env.HOMES.get(env.HOMES.idFromName(homeKey)).fetch(`https://test${path}`, { method });
const waitForFenceAck = (env: TestEnv, homeKey: string, count = 1) =>
  requestHome(env, homeKey, `/test/wait-fence-ack?count=${count}`).then((response) => {
    expect(response.status).toBe(204);
  });

describe("Catalog HomeObject in workerd", () => {
  it("activates distinct roots, replays grants and denies access after revocation and eviction", async () => {
    const worker = workerFor();
    const env = await environment();
    const homes = catalogHomes(env.HOMES, env);
    const home = homeFor("owner");
    const personal = homes.personal(home);
    const owner = { userId: "owner" };
    const guest = { userId: "guest" };

    const initialized = await personal.initialize();
    expect(initialized).toMatchObject({
      _tag: "Committed",
      value: { defined: true, value: { changed: true } },
    });
    expect(await personal.initialize()).toEqual(initialized);
    expect(await personal.view(owner, query)).toMatchObject({
      _tag: "Value",
      value: { defined: true, value: { role: "Owner" } },
    });
    await expect(personal.view(guest, query)).rejects.toThrow();

    const command = {
      name: "setGrant",
      input: { target: root, personId: guest.userId, role: "Admin" },
    } as const;
    const added = await personal.change(owner, command, "grant-guest");
    expect(["Pending", "Committed"]).toContain(added._tag);
    expect(await personal.view(guest, query)).toMatchObject({
      _tag: "Value",
      value: { defined: true, value: { role: "Admin" } },
    });

    const other = homes.personal(homeFor("other-owner"));
    await other.initialize();
    await expect(other.view(guest, query)).rejects.toThrow();

    const revoked = await personal.change(
      owner,
      {
        name: "setGrant",
        input: { target: root, personId: guest.userId, role: null },
      },
      "remove-guest",
    );
    expect(["Pending", "Committed"]).toContain(revoked._tag);
    await expect(personal.view(guest, query)).rejects.toThrow();

    await worker.evictDurableObject("HOMES", { name: catalogHomeKey(home) });
    expect(await personal.view(owner, query)).toMatchObject({
      _tag: "Value",
      value: { defined: true, value: { role: "Owner" } },
    });
    await expect(personal.view(guest, query)).rejects.toThrow();
    await expect(
      personal.change(
        owner,
        {
          name: "setGrant",
          input: { target: root, personId: guest.userId, role: "Viewer" },
        },
        "grant-guest",
      ),
    ).rejects.toThrow();
  });

  it("keeps activation private and rejects legacy sources", async () => {
    expect((await harness.fetch("/_catalog/bind", { method: "POST" })).status).toBe(404);
    const env = await environment();
    const homes = catalogHomes(env.HOMES, env);
    expect(() => homes.personal({ ...homeFor("owner"), legacySource: "owner" })).toThrow();
  });

  it("keeps a failed fence pending across eviction and commits only after native recovery", async () => {
    const worker = workerFor();
    const env = await environment();
    await harness.fetch("/test/recovery/pause");
    const home = homeFor("recovering-owner");
    const homeKey = catalogHomeKey(home);
    const personal = catalogHomes(env.HOMES, env).personal(home);
    const owner = { userId: "recovering-owner" };
    const guest = { userId: "recovering-guest" };
    const client = createShardClient(env.HOMES as unknown as ShardNamespaceLike, {
      shardKey: homeKey,
      system: true,
    });
    const blockFences = (method: "POST" | "DELETE") =>
      requestHome(env, homeKey, "/test/fence-failure", method);
    const command = {
      name: "setGrant",
      input: { target: root, personId: guest.userId, role: "Admin" },
    } as const;
    await personal.initialize();
    await blockFences("POST");
    expect(await personal.change(owner, command, "recovering-grant")).toMatchObject({
      _tag: "Pending",
    });
    expect(await client.call("personalRecovery:sync_recoverFences", { home })).toEqual({
      _tag: "Pending",
    });
    await worker.evictDurableObject("HOMES", { name: homeKey });
    expect(await personal.change(owner, command, "recovering-grant")).toMatchObject({
      _tag: "Pending",
    });

    await blockFences("DELETE");
    await harness.fetch("/test/recovery/resume");
    await waitForFenceAck(env, homeKey);
    expect(await personal.change(owner, command, "recovering-grant")).toMatchObject({
      _tag: "Committed",
    });
    expect(await personal.view(guest, query)).toMatchObject({
      _tag: "Value",
      value: { defined: true, value: { role: "Admin" } },
    });

    const removal = {
      name: "setGrant",
      input: { target: root, personId: guest.userId, role: null },
    } as const;
    expect(await personal.change(guest, removal, "self-revoke")).toMatchObject({ _tag: "Pending" });
    await expect(personal.view(guest, query)).rejects.toThrow();
    await expect(personal.change(guest, removal, "self-revoke")).rejects.toThrow();
    await waitForFenceAck(env, homeKey, 2);
    expect(await (await requestHome(env, homeKey, "/test/epochs")).json()).toEqual({
      savedEpoch: 2,
      nativeEpoch: 2,
    });
    await expect(personal.change(guest, removal, "self-revoke")).rejects.toThrow();
  });

  it("recovers after the native fence commits but its acknowledgment is lost", async () => {
    const worker = workerFor();
    const env = await environment();
    await harness.fetch("/test/recovery/pause");
    const home = homeFor("lost-ack-owner");
    const homeKey = catalogHomeKey(home);
    const owner = { userId: "lost-ack-owner" };
    const personal = catalogHomes(env.HOMES, env).personal(home);
    const client = createShardClient(env.HOMES as unknown as ShardNamespaceLike, {
      shardKey: homeKey,
      system: true,
    });
    await personal.initialize();
    await requestHome(env, homeKey, "/test/fence-failure", "POST");
    const command = {
      name: "setGrant",
      input: { target: root, personId: "lost-ack-guest", role: "Viewer" },
    } as const;
    expect(await personal.change(owner, command, "lost-ack-grant")).toMatchObject({
      _tag: "Pending",
    });
    await requestHome(env, homeKey, "/test/lost-fence-ack", "POST");
    await requestHome(env, homeKey, "/test/fence-failure", "DELETE");
    // The old request's response may itself be fenced after the native commit.
    await client.call("personalRecovery:sync_recoverFences", { home }).catch(() => undefined);
    expect(await (await requestHome(env, homeKey, "/test/epochs")).json()).toEqual({
      savedEpoch: 1,
      nativeEpoch: 1,
    });
    await worker.evictDurableObject("HOMES", { name: homeKey });
    expect(await personal.view(owner, query)).toMatchObject({
      _tag: "Value",
      value: { defined: true, value: { role: "Owner" } },
    });
    await requestHome(env, homeKey, "/test/lost-fence-ack", "DELETE");
    await harness.fetch("/test/recovery/resume");
    await waitForFenceAck(env, homeKey);
    expect(await personal.change(owner, command, "lost-ack-grant")).toMatchObject({
      _tag: "Committed",
    });
  });

  it("fences an open guest subscription and denies subscribing again after revocation", async () => {
    const env = await environment();
    await harness.fetch("/test/recovery/resume");
    const home = homeFor("socket-owner");
    const homeKey = catalogHomeKey(home);
    const personal = catalogHomes(env.HOMES, env).personal(home);
    const owner = { userId: "socket-owner" };
    const guest = { userId: "socket-guest" };
    await personal.initialize();
    await personal.change(
      owner,
      {
        name: "setGrant",
        input: { target: root, personId: guest.userId, role: "Viewer" },
      },
      "socket-grant",
    );
    await waitForFenceAck(env, homeKey);
    const socket = await openCatalogSocket(env.HOMES, homeKey, guest.userId);
    try {
      socket.subscribe("access");
      expect((await socket.waitFor("access", "data")).data).toMatchObject({
        _tag: "Value",
        value: { defined: true, value: { role: "Viewer" } },
      });
      const revoked = socket.waitFor("access", "error");
      await personal.change(
        owner,
        {
          name: "setGrant",
          input: { target: root, personId: guest.userId, role: null },
        },
        "socket-revoke",
      );
      await waitForFenceAck(env, homeKey, 2);
      expect(await (await requestHome(env, homeKey, "/test/epochs")).json()).toEqual({
        savedEpoch: 2,
        nativeEpoch: 2,
      });
      expect(await revoked).toMatchObject({ code: "FORBIDDEN" });
      socket.subscribe("reconnect");
      expect(await socket.waitFor("reconnect", "error")).toMatchObject({ code: "FORBIDDEN" });
      expect(socket.frames.filter((frame) => frame.type === "data")).toHaveLength(1);
    } finally {
      socket.close();
    }
  });
});
