// @effect-diagnostics nodeBuiltinImport:off -- The workerd harness bundles a filesystem entry point.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { createTestHarness } from "wrangler";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";
import type { DurableObjectNamespace as HarnessNamespace } from "@cloudflare/workers-types";

import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { catalogHomes } from "./CatalogHomes.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import { CatalogOrganizationRoot } from "./catalogOrganizationPolicy.ts";
import { CatalogPersonalRoot } from "./catalogPolicy.ts";
import type { CatalogObjectEnv } from "./catalogObjects.ts";
import { openCatalogSocket } from "./tests/catalogSocket.ts";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "catalog-organization-runtime-test",
        main: NodeURL.fileURLToPath(new URL("./tests/catalogRuntime.fixture.ts", import.meta.url)),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          LOCAL_WORKERD: "1",
          LUNORA_RELAY_SECRET: "isolated-org-catalog-test",
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
let origin: string;
beforeAll(async () => {
  origin = (await harness.listen()).url.href;
}, 60_000);
afterAll(() => harness.close());
const worker = () => harness.getWorker<{ readonly HOMES: HarnessNamespace }>();
const environment = async () => (await worker().getEnv()) as unknown as CatalogObjectEnv;
const organizationHome = Schema.decodeUnknownSync(CatalogOrganizationRoot);
const personalHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeFolderId = Schema.decodeUnknownSync(FolderId);
const root = { folderId: null, incarnation: 1 };
const access = { name: "access", input: root } as const;
const orgHome = (id: string) =>
  organizationHome({ owner: { _tag: "organization", id }, level: { _tag: "top" } });
const homeRequest = (env: CatalogObjectEnv, key: string, path: string, method = "GET") =>
  env.HOMES.get(env.HOMES.idFromName(key)).fetch(`https://test${path}`, { method });
const ack = (env: CatalogObjectEnv, key: string, count: number) =>
  homeRequest(env, key, `/test/wait-fence-ack?count=${count}`).then((response) =>
    expect(response.status).toBe(204),
  );

describe("Organization Catalog native delivery", () => {
  it("projects membership, fences downgrade/removal and keeps tombstones across eviction", async () => {
    const env = await environment();
    await harness.fetch("/test/recovery/resume");
    const home = orgHome("membership-org");
    const key = catalogHomeKey(home);
    const organization = catalogHomes(env.HOMES, env).organization(home);
    const member = { userId: "org-member" };
    const bootstrap = { name: "bootstrap", input: { incarnation: 1 } } as const;
    const boot = await organization.project(bootstrap, "bootstrap-membership-org");
    expect(boot._tag).toBe("Committed");
    expect(await organization.project(bootstrap, "bootstrap-membership-org")).toEqual(boot);
    await expect(organization.view(member, access)).rejects.toThrow();
    const membership = (sourceRevision: number, roleSlugs: ReadonlyArray<string> | null) => ({
      name: "syncMembership" as const,
      input: { incarnation: 1, personId: member.userId, sourceRevision, roleSlugs },
    });
    const admin = membership(1, ["admin"]);
    await organization.project(admin, "membership-admin");
    await ack(env, key, 1);
    expect((await organization.project(admin, "membership-admin"))._tag).toBe("Committed");
    expect(await organization.view(member, access)).toMatchObject({
      value: { value: { role: "Admin" } },
    });

    const socket = await openCatalogSocket(origin, key, member.userId, "organization");
    try {
      socket.subscribe("before");
      expect((await socket.waitFor("before", "data")).data).toMatchObject({
        value: { value: { role: "Admin" } },
      });
      await organization.project(membership(2, ["member"]), "membership-downgrade");
      await ack(env, key, 2);
      expect(await organization.view(member, access)).toMatchObject({
        value: { value: { role: "Viewer" } },
      });
      await expect(
        organization.change(
          member,
          {
            name: "setGrant",
            input: { target: root, personId: "another-member", role: "Admin" },
          },
          "viewer-cannot-grant",
        ),
      ).rejects.toThrow();
      socket.subscribe("viewer");
      expect((await socket.waitFor("viewer", "data")).data).toMatchObject({
        value: { value: { role: "Viewer" } },
      });
      const removedSubscription = socket.waitFor("viewer", "error");
      await organization.project(membership(3, null), "membership-remove");
      await ack(env, key, 3);
      expect(await removedSubscription).toMatchObject({ code: "FORBIDDEN" });
      await expect(organization.view(member, access)).rejects.toThrow();
      socket.subscribe("removed");
      expect(await socket.waitFor("removed", "error")).toMatchObject({ code: "FORBIDDEN" });
    } finally {
      socket.close();
    }

    await worker().evictDurableObject("HOMES", { name: key });
    expect((await organization.project(membership(1, ["admin"]), "stale-membership"))._tag).toBe(
      "Committed",
    );
    await expect(organization.view(member, access)).rejects.toThrow();
    await expect(
      organization.project(membership(3, ["admin"]), "conflicting-membership"),
    ).rejects.toThrow();
    await organization.project(membership(4, ["member"]), "membership-rejoin");
    await ack(env, key, 1);
    expect(await organization.view(member, access)).toMatchObject({
      value: { value: { role: "Viewer" } },
    });
    await expect(
      organization.project(membership(5, ["admin"]), "membership-rejoin"),
    ).rejects.toThrow();
  });

  it("keeps membership delivery pending until recovered and files a personal reference without granting access", async () => {
    const env = await environment();
    await harness.fetch("/test/recovery/pause");
    const homes = catalogHomes(env.HOMES, env);
    const home = orgHome("recovering-org");
    const key = catalogHomeKey(home);
    const org = homes.organization(home);
    await org.project({ name: "bootstrap", input: { incarnation: 1 } }, "recovering-bootstrap");
    const delivery = {
      name: "syncMembership",
      input: {
        incarnation: 1,
        personId: "recovering-member",
        sourceRevision: 1,
        roleSlugs: ["admin"],
      },
    } as const;
    await homeRequest(env, key, "/test/fence-failure", "POST");
    expect((await org.project(delivery, "recovering-membership"))._tag).toBe("Pending");
    await worker().evictDurableObject("HOMES", { name: key });
    expect((await org.project(delivery, "recovering-membership"))._tag).toBe("Pending");
    await homeRequest(env, key, "/test/fence-failure", "DELETE");
    await harness.fetch("/test/recovery/resume");
    await ack(env, key, 1);
    expect((await org.project(delivery, "recovering-membership"))._tag).toBe("Committed");

    const personal = homes.personal(
      personalHome({ owner: { _tag: "person", id: "reference-owner" }, level: { _tag: "top" } }),
    );
    const reference = {
      name: "ensureOrganizationReference",
      input: { incarnation: 1, target: { home, incarnation: 1 } },
    } as const;
    const filed = await personal.project(reference, "file-org-reference");
    expect(filed._tag).toBe("Committed");
    expect(await personal.project(reference, "file-org-reference")).toEqual(filed);
    expect(
      await personal.view(
        { userId: "reference-owner" },
        { name: "referencePlacements", input: { after: null } },
      ),
    ).toMatchObject({ value: { value: { placements: [{ target: { home, incarnation: 1 } }] } } });
    const filedFolderId = decodeFolderId("filed-org-reference");
    const filedHome = personalHome({
      owner: { _tag: "person", id: "reference-owner" },
      level: { _tag: "top" },
    });
    await personal.change(
      { userId: "reference-owner" },
      { name: "createFolder", input: { parent: root, folderId: filedFolderId, name: "Filed" } },
      "create-filing-folder",
    );
    expect(
      (
        await personal.change(
          { userId: "reference-owner" },
          {
            name: "moveOrganizationReference",
            input: {
              target: { home, incarnation: 1 },
              filedUnder: {
                home: { owner: filedHome.owner, level: { _tag: "folder", id: filedFolderId } },
                incarnation: 1,
              },
            },
          },
          "move-org-reference",
        )
      )._tag,
    ).toBe("Committed");
    expect(
      await personal.view(
        { userId: "reference-owner" },
        { name: "referencePlacements", input: { after: null } },
      ),
    ).toMatchObject({
      value: {
        value: {
          placements: [{ filedUnder: { home: { level: { _tag: "folder", id: filedFolderId } } } }],
        },
      },
    });
    await expect(org.view({ userId: "reference-owner" }, access)).rejects.toThrow();
    const raw = createShardClient(env.HOMES as unknown as ShardNamespaceLike, {
      shardKey: key,
      system: false,
    }).as({ userId: "recovering-member", claims: { catalogHomeKey: key } });
    await expect(
      raw.call("organization:project_syncMembership", {
        input: { defined: true, value: delivery.input },
        operationKey: "public-forgery",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      raw.call("personal:view_access", { input: { defined: true, value: root } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("routes folder create/list/retire/reopen on both root authorities", async () => {
    const env = await environment();
    await harness.fetch("/test/recovery/resume");
    const homes = catalogHomes(env.HOMES, env);
    const person = personalHome({
      owner: { _tag: "person", id: "lifecycle-person" },
      level: { _tag: "top" },
    });
    const organization = orgHome("lifecycle-org");
    const org = homes.organization(organization);
    await org.project({ name: "bootstrap", input: { incarnation: 1 } }, "lifecycle-bootstrap");
    await org.project(
      {
        name: "syncMembership",
        input: {
          incarnation: 1,
          personId: "lifecycle-admin",
          sourceRevision: 1,
          roleSlugs: ["admin"],
        },
      },
      "lifecycle-admin",
    );
    await ack(env, catalogHomeKey(organization), 1);
    for (const entry of [
      {
        client: homes.personal(person),
        actor: { userId: "lifecycle-person" },
        key: catalogHomeKey(person),
        count: 0,
        id: "personal-child",
      },
      {
        client: org,
        actor: { userId: "lifecycle-admin" },
        key: catalogHomeKey(organization),
        count: 1,
        id: "organization-child",
      },
    ]) {
      const folderId = decodeFolderId(entry.id);
      const target = { folderId, incarnation: 1 };
      expect(
        (
          await entry.client.change(
            entry.actor,
            { name: "createFolder", input: { parent: root, folderId, name: "Child" } },
            "create-child",
          )
        )._tag,
      ).toBe("Committed");
      const children = { name: "children", input: { parent: root, after: null } } as const;
      expect(await entry.client.view(entry.actor, children)).toMatchObject({
        value: { value: { children: [{ name: "Child" }] } },
      });
      await entry.client.view(entry.actor, { name: "access", input: target });
      await entry.client.change(
        entry.actor,
        { name: "retireFolder", input: { target } },
        "retire-child",
      );
      await ack(env, entry.key, entry.count + 1);
      expect(await entry.client.view(entry.actor, children)).toMatchObject({
        value: { value: { children: [] } },
      });
      await entry.client.change(
        entry.actor,
        { name: "reopenFolder", input: { target } },
        "reopen-child",
      );
      await ack(env, entry.key, entry.count + 2);
      expect(await entry.client.view(entry.actor, children)).toMatchObject({
        value: { value: { children: [{ name: "Child" }] } },
      });
    }
  });
});
