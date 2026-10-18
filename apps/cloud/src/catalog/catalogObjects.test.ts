import { describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { DeliveryAuthorizationRequest } from "lunorash/do";
import type { ShardClient } from "lunorash/runtime";

import { catalogHomeKey } from "./catalogHome.ts";
import { CatalogOrganizationRoot } from "./catalogOrganizationPolicy.ts";
import {
  assertCatalogHomeId,
  makeCatalogDeliveryAuthorization,
  nativeCatalogScope,
} from "./catalogObjects.ts";
import type { CatalogHomeNamespace } from "./catalogObjects.ts";
import type { CatalogRuntimePorts } from "./catalogObjects.ts";

const home = { owner: { _tag: "person", id: "person_1" }, level: { _tag: "top" } } as const;
const homeKey = catalogHomeKey(home);
const decodeOrganizationHome = Schema.decodeUnknownSync(CatalogOrganizationRoot);
const organizationHome = decodeOrganizationHome({
  owner: { _tag: "organization", id: "org_1" },
  level: { _tag: "top" },
});
const organizationHomeKey = catalogHomeKey(organizationHome);

const requestFor = (
  boundHome: typeof home | typeof organizationHome,
  overrides: Partial<DeliveryAuthorizationRequest> = {},
): DeliveryAuthorizationRequest => {
  const boundKey = catalogHomeKey(boundHome);
  return {
    admin: false,
    args: { input: { defined: true, value: { folderId: null, incarnation: 1 } } },
    functionPath: `${boundHome.owner._tag === "person" ? "personal" : "organization"}:view_access`,
    identity: { userId: "person_1", identity: { catalogHomeKey: boundKey } },
    shardKey: boundKey,
    system: false,
    transport: "rpc",
    ...overrides,
  };
};

const request = (overrides: Partial<DeliveryAuthorizationRequest> = {}) =>
  requestFor(home, overrides);

const namespaceFor = (id: DurableObjectId): CatalogHomeNamespace => ({
  idFromName: (name) =>
    ({ toString: () => (name === homeKey ? id.toString() : `other:${name}`) }) as DurableObjectId,
  get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
  jurisdiction: (name) => {
    expect(name).toBe("eu");
    return namespaceFor(id);
  },
});

describe("Catalog physical home identity and delivery", () => {
  it("hashes long logical home keys into a stable native fence scope", async () => {
    const longHome = {
      owner: { _tag: "person", id: "p".repeat(256) },
      level: { _tag: "top" },
    } as const;
    const logicalScope = catalogHomeKey(longHome);
    const first = await nativeCatalogScope(logicalScope);

    expect(logicalScope.length).toBeGreaterThan(256);
    expect(first).toBe(await nativeCatalogScope(logicalScope));
    expect(first).toMatch(/^catalog:[0-9a-f]{64}$/);
    expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(256);
    expect(first).not.toBe(logicalScope);
    expect(await nativeCatalogScope("abc")).toBe(
      "catalog:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("requires the DO id to match the canonical namespace name", () => {
    const matchingId = { toString: () => `id:${homeKey}` } as DurableObjectId;
    const namespace = namespaceFor(matchingId);
    expect(assertCatalogHomeId(namespace, matchingId, home)).toBe(homeKey);
    expect(() =>
      assertCatalogHomeId(namespace, { toString: () => "id:other" } as DurableObjectId, home),
    ).toThrow("does not match its canonical home");
  });

  it("resolves only allowlisted user requests against the exact bound home", async () => {
    const calls: Array<{ reference: unknown; args: unknown }> = [];
    let permitEpoch = 4;
    const client = {
      call: async (reference: unknown, args: unknown) => {
        calls.push({ reference, args });
        return { scope: await nativeCatalogScope(homeKey), epoch: permitEpoch };
      },
    } as unknown as ShardClient;
    const ports: CatalogRuntimePorts = {
      home: async () => home,
      currentEpoch: () => 3,
      install: async () => {},
      client: () => client,
      readPermit: (args) => client.call("catalogRuntime:deliveryPermit", args),
    };
    const authorize = makeCatalogDeliveryAuthorization(ports);

    const permit = { scope: await nativeCatalogScope(homeKey), epoch: 4 };
    for (const functionPath of [
      "personal:view_access",
      "personal:view_children",
      "personal:view_referencePlacements",
      "personal:change_createFolder",
      "personal:change_retireFolder",
      "personal:change_reopenFolder",
      "personal:change_renameFolder",
      "personal:change_moveFolder",
      "personal:change_setGrant",
      "personal:change_moveOrganizationReference",
    ]) {
      await expect(authorize(request({ functionPath }))).resolves.toEqual(permit);
    }
    expect(calls).toHaveLength(10);
    expect(calls[0]?.reference).toBe("catalogRuntime:deliveryPermit");
    expect(calls[0]?.args).toEqual({
      userId: "person_1",
      functionPath: "personal:view_access",
      args: { input: { defined: true, value: { folderId: null, incarnation: 1 } } },
    });

    await expect(authorize(request({ shardKey: "other" }))).resolves.toBeUndefined();
    await expect(
      authorize(
        request({ identity: { userId: "person_1", identity: { catalogHomeKey: "other" } } }),
      ),
    ).resolves.toBeUndefined();
    await expect(authorize(request({ admin: true }))).resolves.toBeUndefined();
    await expect(
      authorize(request({ functionPath: "catalogRuntime:deliveryPermit" })),
    ).resolves.toBeUndefined();
    await expect(
      authorize(
        request({ transport: "subscription", functionPath: "catalogRuntime:deliveryPermit" }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authorize(request({ functionPath: "personal:project_initialize" })),
    ).resolves.toBeUndefined();
    await expect(
      authorize(request({ functionPath: "personal:project_initialize", system: true })),
    ).resolves.toBeUndefined();
    await expect(
      authorize(request({ functionPath: "personal:project_ensureOrganizationReference" })),
    ).resolves.toBeUndefined();
    await expect(
      authorize(request({ functionPath: "organization:project_bootstrap" })),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(10);

    permitEpoch = 2;
    await expect(authorize(request())).resolves.toBeUndefined();
  });

  it("rejects a delivery permit scoped to another native home", async () => {
    const client = {
      call: async () => ({ scope: "catalog:another-home", epoch: 4 }),
    } as unknown as ShardClient;
    const ports: CatalogRuntimePorts = {
      home: async () => home,
      currentEpoch: () => 3,
      install: async () => {},
      client: () => client,
      readPermit: (args) => client.call("catalogRuntime:deliveryPermit", args),
    };

    await expect(makeCatalogDeliveryAuthorization(ports)(request())).resolves.toBeUndefined();
  });

  it("routes organization user requests only through organization functions on that home", async () => {
    const calls: Array<{ reference: unknown; args: unknown }> = [];
    const client = {
      call: async (reference: unknown, args: unknown) => {
        calls.push({ reference, args });
        return { scope: await nativeCatalogScope(organizationHomeKey), epoch: 2 };
      },
    } as unknown as ShardClient;
    const ports: CatalogRuntimePorts = {
      home: async () => organizationHome,
      currentEpoch: () => 2,
      install: async () => {},
      client: () => client,
      readPermit: (args) => client.call("catalogRuntime:deliveryPermit", args),
    };
    const authorize = makeCatalogDeliveryAuthorization(ports);
    const permit = { scope: await nativeCatalogScope(organizationHomeKey), epoch: 2 };

    for (const functionPath of [
      "organization:view_access",
      "organization:view_children",
      "organization:change_createFolder",
      "organization:change_retireFolder",
      "organization:change_reopenFolder",
      "organization:change_renameFolder",
      "organization:change_moveFolder",
      "organization:change_setGrant",
    ]) {
      await expect(authorize(requestFor(organizationHome, { functionPath }))).resolves.toEqual(
        permit,
      );
    }
    await expect(
      authorize(requestFor(organizationHome, { functionPath: "personal:view_access" })),
    ).resolves.toBeUndefined();
    await expect(
      authorize(
        requestFor(organizationHome, {
          functionPath: "organization:project_syncMembership",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authorize(requestFor(organizationHome, { shardKey: "another-home" })),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(8);
  });

  it("allows only owner-specific projections and recovery system calls on their home", async () => {
    const client = { call: vi.fn() } as unknown as ShardClient;
    const authorizeFor = (boundHome: typeof home | typeof organizationHome) => {
      const ports: CatalogRuntimePorts = {
        home: async () => boundHome,
        currentEpoch: () => 0,
        install: async () => {},
        client: () => client,
        readPermit: (args) => client.call("catalogRuntime:deliveryPermit", args),
      };
      return makeCatalogDeliveryAuthorization(ports);
    };
    const allowSystem = (
      boundHome: typeof home | typeof organizationHome,
      functionPath: string,
      args: Record<string, unknown>,
    ) => authorizeFor(boundHome)(requestFor(boundHome, { system: true, functionPath, args }));

    await expect(
      allowSystem(home, "catalogRuntime:deliveryPermit", {
        userId: "person_1",
        functionPath: "personal:view_access",
        args: { input: { defined: true, value: { folderId: null, incarnation: 1 } } },
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(home, "personal:project_initialize", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "catalog-home-initialize-v1",
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(homeKey), epoch: 0 });
    await expect(
      allowSystem(home, "personal:project_initialize", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "other",
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(home, "personal:project_ensureOrganizationReference", {
        input: { defined: true, value: { organizationId: "org_1", incarnation: 1 } },
        operationKey: "delivery-1",
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(homeKey), epoch: 0 });
    await expect(
      allowSystem(organizationHome, "organization:project_bootstrap", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "bootstrap-org-1",
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(organizationHomeKey), epoch: 0 });
    await expect(
      allowSystem(home, "organization:project_bootstrap", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "bootstrap-org-2",
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(organizationHome, "personal:project_initialize", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "catalog-home-initialize-v1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(organizationHome, "organization:project_syncMembership", {
        input: {
          defined: true,
          value: {
            incarnation: 1,
            personId: "person_1",
            sourceRevision: 1,
            roleSlugs: ["member"],
          },
        },
        operationKey: "membership-org-1",
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(organizationHomeKey), epoch: 0 });
    await expect(
      allowSystem(home, "personalRecovery:sync_scheduleFenceRecovery", { home }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(homeKey), epoch: 0 });
    await expect(
      allowSystem(home, "personalRecovery:sync_scheduleFenceRecovery", {
        home: { ...home, owner: { _tag: "person", id: "other" } },
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(home, "organizationRecovery:sync_scheduleFenceRecovery", {
        home: organizationHome,
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(organizationHome, "personalRecovery:sync_scheduleFenceRecovery", {
        home,
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(organizationHome, "organizationRecovery:sync_scheduleFenceRecovery", {
        home: organizationHome,
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(organizationHomeKey), epoch: 0 });
    await expect(
      allowSystem(organizationHome, "organization:project_unlisted", {
        operationKey: "anything",
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem(organizationHome, "organization:change_setGrant", { input: {} }),
    ).resolves.toBeUndefined();
    expect(client.call).not.toHaveBeenCalled();
  });
});
