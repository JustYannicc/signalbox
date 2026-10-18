import * as Schema from "effect/Schema";
import type { DeliveryAuthorization, DeliveryPermit } from "lunorash/do";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import { catalogHomeKey } from "./catalogHome.ts";
import { CatalogRootHome } from "./catalogHomeSchema.ts";
import type { DurableObjectStorageObserverEnv } from "../observability/DurableObjectStorage.ts";
import type { CatalogRuntimePorts } from "./lunora/env.ts";

export const CATALOG_HOME_JURISDICTION = "eu" as const;
export const CATALOG_HOME_BIND_PATH = "/_catalog/bind";
export const CATALOG_HOME_BIND_HEADER = "x-catalog-home-bind";

export interface CatalogHomeObjectStub {
  readonly fetch: (request: Request | string, init?: RequestInit) => Promise<Response>;
}

/** The namespace is private to Worker bindings; it has no public HTTP route. */
export interface CatalogHomeNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => CatalogHomeObjectStub;
  readonly jurisdiction?: (name: typeof CATALOG_HOME_JURISDICTION) => CatalogHomeNamespace;
}

export interface CatalogObjectEnv extends DurableObjectStorageObserverEnv {
  readonly HOMES: CatalogHomeNamespace;
  readonly LOCAL_WORKERD?: string;
  readonly LUNORA_RELAY_SECRET?: string;
  readonly SESSION_SECRET?: string;
}

const decodeRootHome = Schema.decodeUnknownSync(CatalogRootHome);
const encode = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalRoot = (input: unknown): typeof CatalogRootHome.Type => {
  const home = decodeRootHome(input);
  if (home.legacySource !== undefined) throw new Error("Legacy Catalog homes cannot be activated.");
  return home;
};

export const catalogHomeNamespace = (
  namespace: CatalogHomeNamespace,
  localWorkerd: boolean,
): CatalogHomeNamespace => {
  if (localWorkerd) return namespace;
  if (namespace.jurisdiction === undefined) {
    throw new Error("Catalog home EU namespace is unavailable.");
  }
  return namespace.jurisdiction(CATALOG_HOME_JURISDICTION);
};

/** The Lunora socket metadata limit is 256 bytes; hash the longer logical key. */
export const nativeCatalogScope = async (logicalScope: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encode.encode(logicalScope));
  return `catalog:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const validEpoch = (epoch: unknown): epoch is number =>
  typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0;

export const catalogRelaySecret = (env: CatalogObjectEnv): string => {
  if (typeof env.LUNORA_RELAY_SECRET === "string" && env.LUNORA_RELAY_SECRET.length > 0) {
    return env.LUNORA_RELAY_SECRET;
  }
  if (
    env.LOCAL_WORKERD === "1" &&
    typeof env.SESSION_SECRET === "string" &&
    env.SESSION_SECRET.length > 0
  ) {
    return `catalog:${env.SESSION_SECRET}`;
  }
  throw new Error("Catalog home relay secret is not configured.");
};

const sameRequestedShard = (request: Parameters<DeliveryAuthorization>[0], homeKey: string) =>
  request.shardKey === homeKey;

const recoveryFunctions = new Set([
  "personalRecovery:sync_pendingFences",
  "personalRecovery:sync_scheduleFenceRecovery",
  "personalRecovery:sync_acknowledgeFence",
  "personalRecovery:sync_recoverFences",
]);

const publicFunctions = new Set([
  "personal:view_access",
  "personal:change_renameFolder",
  "personal:change_moveFolder",
  "personal:change_setGrant",
]);

const isBoundHomeArgument = (value: unknown, homeKey: string) => {
  if (!isRecord(value) || !Object.hasOwn(value, "home")) return false;
  try {
    return catalogHomeKey(canonicalRoot(value.home)) === homeKey;
  } catch {
    return false;
  }
};

const isBootstrapRequest = (request: Parameters<DeliveryAuthorization>[0]) => {
  const { args } = request;
  if (!isRecord(args) || args.operationKey !== "catalog-home-initialize-v1") return false;
  const input = args.input;
  return (
    isRecord(input) &&
    input.defined === true &&
    isRecord(input.value) &&
    input.value.incarnation === 1
  );
};

const authorityPermit = (scope: string, epoch: number): DeliveryPermit => ({ scope, epoch });

/**
 * Native Lunora checks every RPC and subscription before receipt replay. System calls are
 * limited to the home bootstrap, fence recovery, and the one recursive authority lookup.
 */
export const makeCatalogDeliveryAuthorization =
  (ports: CatalogRuntimePorts): DeliveryAuthorization =>
  async (request) => {
    if (request.admin) return undefined;

    let home: typeof CatalogRootHome.Type;
    let homeKey: string;
    try {
      home = canonicalRoot(await ports.home());
      homeKey = catalogHomeKey(home);
    } catch {
      return undefined;
    }
    if (!sameRequestedShard(request, homeKey)) return undefined;

    const nativeScope = await nativeCatalogScope(homeKey);
    if (request.system) {
      if (request.transport !== "rpc") return undefined;
      if (request.functionPath === "catalogRuntime:deliveryPermit") {
        if (
          !isRecord(request.args) ||
          typeof request.args.userId !== "string" ||
          typeof request.args.functionPath !== "string" ||
          !isRecord(request.args.args)
        ) {
          return undefined;
        }
        return authorityPermit(nativeScope, ports.currentEpoch());
      }
      if (
        request.functionPath === "personal:project_initialize" &&
        home.owner._tag === "person" &&
        home.legacySource === undefined &&
        isBootstrapRequest(request)
      ) {
        return authorityPermit(nativeScope, ports.currentEpoch());
      }
      if (
        recoveryFunctions.has(request.functionPath) &&
        isBoundHomeArgument(request.args, homeKey)
      ) {
        return authorityPermit(nativeScope, ports.currentEpoch());
      }
      return undefined;
    }

    if (
      (request.transport !== "rpc" && request.transport !== "subscription") ||
      !publicFunctions.has(request.functionPath)
    ) {
      return undefined;
    }
    const userId = request.identity.userId;
    const claims = request.identity.identity;
    if (typeof userId !== "string" || !isRecord(claims) || claims.catalogHomeKey !== homeKey) {
      return undefined;
    }

    const result = await ports.client().call("catalogRuntime:deliveryPermit", {
      userId,
      functionPath: request.functionPath,
      args: request.args,
    });
    if (!isRecord(result) || result.scope !== nativeScope || !validEpoch(result.epoch)) {
      return undefined;
    }
    if (result.epoch < ports.currentEpoch()) return undefined;
    return authorityPermit(nativeScope, result.epoch);
  };

/** Build the internal runtime ports before the generated ShardDO constructor runs. */
export const catalogRuntimePorts = (options: {
  readonly env: CatalogObjectEnv;
  readonly getHome: () => Promise<typeof CatalogRootHome.Type>;
  readonly getHomeKey: () => string;
  readonly getEpoch: () => number;
  readonly install: (fence: { readonly scope: string; readonly epoch: number }) => Promise<void>;
}): CatalogRuntimePorts => {
  const localWorkerd = options.env.LOCAL_WORKERD === "1";
  return {
    home: options.getHome,
    currentEpoch: options.getEpoch,
    install: options.install,
    client: () => {
      const homeKey = options.getHomeKey();
      return createShardClient(options.env.HOMES as unknown as ShardNamespaceLike, {
        shardKey: homeKey,
        system: true,
        ...(localWorkerd ? {} : { jurisdiction: CATALOG_HOME_JURISDICTION }),
      });
    },
  };
};

export const assertCatalogHomeId = (
  namespace: CatalogHomeNamespace,
  id: DurableObjectId,
  home: typeof CatalogRootHome.Type,
) => {
  const key = catalogHomeKey(canonicalRoot(home));
  if (id.toString() !== namespace.idFromName(key).toString()) {
    throw new Error("Catalog home Durable Object ID does not match its canonical home.");
  }
  return key;
};

export const isCatalogHomeRoot = (input: unknown): input is typeof CatalogRootHome.Type => {
  try {
    canonicalRoot(input);
    return true;
  } catch {
    return false;
  }
};

export const decodeCatalogRootHome = canonicalRoot;
