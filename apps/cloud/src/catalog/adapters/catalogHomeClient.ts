import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import {
  CATALOG_HOME_BIND_HEADER,
  CATALOG_HOME_BIND_PATH,
  catalogHomeNamespace,
  catalogRelaySecret,
  type CatalogHomeNamespace,
} from "../catalogObjects.ts";
import { catalogHomeKey } from "../catalogHome.ts";
import type { CatalogRootHome } from "../catalogHomeSchema.ts";
import type { CatalogPolicyActor } from "../catalogPolicy.ts";

export const CATALOG_HOME_INITIALIZATION_OPERATION_KEY = "catalog-home-initialize-v1";

export interface CatalogHomesEnv {
  readonly LOCAL_WORKERD?: string;
  readonly LUNORA_RELAY_SECRET?: string;
  readonly SESSION_SECRET?: string;
}

/** Binding is immutable; failed activation stays retryable on the same facade. */
export const catalogHomeClient = (
  namespace: CatalogHomeNamespace,
  env: CatalogHomesEnv,
  home: typeof CatalogRootHome.Type,
) => {
  const local = env.LOCAL_WORKERD === "1";
  const ids = catalogHomeNamespace(namespace, local);
  const homeKey = catalogHomeKey(home);
  const secret = catalogRelaySecret({ ...env, HOMES: namespace });
  let bound: Promise<void> | undefined;
  const bind = async () => {
    const response = await ids
      .get(ids.idFromName(homeKey))
      .fetch(`https://catalog.internal${CATALOG_HOME_BIND_PATH}`, {
        method: "POST",
        headers: { [CATALOG_HOME_BIND_HEADER]: secret, "content-type": "application/json" },
        body: JSON.stringify({ home }),
      });
    if (response.status !== 204) throw new Error("Catalog home activation failed.");
  };
  const client = (system: boolean) =>
    createShardClient(namespace as unknown as ShardNamespaceLike, {
      shardKey: homeKey,
      system,
      ...(local ? {} : { jurisdiction: "eu" as const }),
    });
  return {
    bound: () => {
      bound ??= bind().catch((error: unknown) => {
        bound = undefined;
        throw error;
      });
      return bound;
    },
    system: () => client(true),
    user: (actor: typeof CatalogPolicyActor.Type) =>
      client(false).as({
        userId: actor.userId,
        claims: { catalogHomeKey: homeKey },
      }),
  };
};
