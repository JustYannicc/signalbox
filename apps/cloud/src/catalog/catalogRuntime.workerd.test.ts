// @effect-diagnostics nodeBuiltinImport:off -- The workerd harness bundles a filesystem entry point.
import * as NodeURL from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { createTestHarness } from "wrangler";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import { catalogHomes } from "./CatalogHomes.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import type { CatalogObjectEnv } from "./catalogObjects.ts";
import { CatalogPersonalRoot } from "./catalogPolicy.ts";

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
interface TestEnv extends CatalogObjectEnv {
  readonly HOMES: DurableObjectNamespace;
}

describe("Catalog HomeObject in workerd", () => {
  it("activates distinct roots, replays grants and denies access after revocation and eviction", async () => {
    const worker = harness.getWorker<TestEnv>();
    const env = await worker.getEnv();
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
    const env = await harness.getWorker<CatalogObjectEnv>().getEnv();
    const homes = catalogHomes(env.HOMES, env);
    expect(() => homes.personal({ ...homeFor("owner"), legacySource: "owner" })).toThrow();
  });

  it("keeps a failed fence pending across eviction and commits only after native recovery", async () => {
    const worker = harness.getWorker<TestEnv>();
    const env = await worker.getEnv();
    const home = homeFor("recovering-owner");
    const homeKey = catalogHomeKey(home);
    const personal = catalogHomes(env.HOMES, env).personal(home);
    const owner = { userId: "recovering-owner" };
    const guest = { userId: "recovering-guest" };
    const client = createShardClient(env.HOMES as unknown as ShardNamespaceLike, {
      shardKey: homeKey,
      system: true,
    });
    const stub = env.HOMES.get(env.HOMES.idFromName(homeKey));
    const command = {
      name: "setGrant",
      input: { target: root, personId: guest.userId, role: "Admin" },
    } as const;
    await personal.initialize();
    await stub.fetch("https://test/test/fence-failure", { method: "POST" });
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

    await stub.fetch("https://test/test/fence-failure", { method: "DELETE" });
    expect(await client.call("personalRecovery:sync_recoverFences", { home })).toEqual({
      _tag: "Drained",
    });
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
    expect(await client.call("personalRecovery:sync_recoverFences", { home })).toEqual({
      _tag: "Drained",
    });
    await expect(personal.change(guest, removal, "self-revoke")).rejects.toThrow();
  });
});
