import { describe, expect, it, vi } from "@effect/vitest";
import type { DeliveryAuthorizationRequest } from "lunorash/do";
import type { ShardClient } from "lunorash/runtime";

import { catalogHomeKey } from "./catalogHome.ts";
import {
  assertCatalogHomeId,
  makeCatalogDeliveryAuthorization,
  nativeCatalogScope,
} from "./catalogObjects.ts";
import type { CatalogHomeNamespace } from "./catalogObjects.ts";
import type { CatalogRuntimePorts } from "./lunora/env.ts";

const home = { owner: { _tag: "person", id: "person_1" }, level: { _tag: "top" } } as const;
const homeKey = catalogHomeKey(home);

const request = (
  overrides: Partial<DeliveryAuthorizationRequest> = {},
): DeliveryAuthorizationRequest => ({
  admin: false,
  args: { input: { defined: true, value: { folderId: null, incarnation: 1 } } },
  functionPath: "personal:view_access",
  identity: { userId: "person_1", identity: { catalogHomeKey: homeKey } },
  shardKey: homeKey,
  system: false,
  transport: "rpc",
  ...overrides,
});

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
    };
    const authorize = makeCatalogDeliveryAuthorization(ports);

    const permit = { scope: await nativeCatalogScope(homeKey), epoch: 4 };
    for (const functionPath of [
      "personal:view_access",
      "personal:change_renameFolder",
      "personal:change_moveFolder",
      "personal:change_setGrant",
    ]) {
      await expect(authorize(request({ functionPath }))).resolves.toEqual(permit);
    }
    expect(calls).toHaveLength(4);
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
      authorize(request({ functionPath: "personal:project_initialize" })),
    ).resolves.toBeUndefined();
    await expect(
      authorize(request({ functionPath: "personal:project_initialize", system: true })),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(4);

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
    };

    await expect(makeCatalogDeliveryAuthorization(ports)(request())).resolves.toBeUndefined();
  });

  it("allows only the exact home bootstrap and recovery system calls", async () => {
    const client = { call: vi.fn() } as unknown as ShardClient;
    const ports: CatalogRuntimePorts = {
      home: async () => home,
      currentEpoch: () => 0,
      install: async () => {},
      client: () => client,
    };
    const authorize = makeCatalogDeliveryAuthorization(ports);
    const allowSystem = (functionPath: string, args: Record<string, unknown>) =>
      authorize(request({ system: true, functionPath, args }));

    await expect(
      allowSystem("catalogRuntime:deliveryPermit", {
        userId: "person_1",
        functionPath: "personal:view_access",
        args: { input: { defined: true, value: { folderId: null, incarnation: 1 } } },
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(homeKey), epoch: 0 });
    await expect(
      allowSystem("catalogRuntime:deliveryPermit", { userId: "person_1" }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem("personal:project_initialize", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "catalog-home-initialize-v1",
      }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(homeKey), epoch: 0 });
    await expect(
      allowSystem("personal:project_initialize", {
        input: { defined: true, value: { incarnation: 1 } },
        operationKey: "other",
      }),
    ).resolves.toBeUndefined();
    await expect(
      allowSystem("personalRecovery:sync_scheduleFenceRecovery", { home }),
    ).resolves.toEqual({ scope: await nativeCatalogScope(homeKey), epoch: 0 });
    await expect(
      allowSystem("personalRecovery:sync_scheduleFenceRecovery", {
        home: { ...home, owner: { _tag: "person", id: "other" } },
      }),
    ).resolves.toBeUndefined();
    await expect(allowSystem("personal:change_setGrant", { input: {} })).resolves.toBeUndefined();
    expect(client.call).not.toHaveBeenCalled();
  });
});
