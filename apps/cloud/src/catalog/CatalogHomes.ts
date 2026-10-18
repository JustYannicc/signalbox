import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";
import * as Schema from "effect/Schema";

import { encodeWireValue } from "@signalbox/sync/adapters/lunoraWireValue";
import { api } from "./lunora/_generated/api.js";
import { internal } from "./lunora/_generated/internal.js";

import { CatalogMoveFolder, CatalogRenameFolder } from "./adapters/catalogTopology.ts";
import {
  CATALOG_HOME_BIND_HEADER,
  CATALOG_HOME_BIND_PATH,
  catalogHomeNamespace,
  catalogRelaySecret,
  type CatalogHomeNamespace,
} from "./catalogObjects.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import { CatalogPersonalRoot, CatalogPolicyActor, CatalogPolicyTarget } from "./catalogPolicy.ts";

export const CATALOG_HOME_INITIALIZATION_OPERATION_KEY = "catalog-home-initialize-v1";
const decodePersonalRoot = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);

export type CatalogQuery = {
  readonly name: "access";
  readonly input: typeof CatalogPolicyTarget.Type;
};

export type CatalogCommand =
  | { readonly name: "renameFolder"; readonly input: typeof CatalogRenameFolder.Type }
  | { readonly name: "moveFolder"; readonly input: typeof CatalogMoveFolder.Type }
  | {
      readonly name: "setGrant";
      readonly input: {
        readonly target: typeof CatalogPolicyTarget.Type;
        readonly personId: string;
        readonly role: "Admin" | "Member" | "Viewer" | null;
      };
    };

export interface CatalogHomesEnv {
  readonly LOCAL_WORKERD?: string;
  readonly LUNORA_RELAY_SECRET?: string;
  readonly SESSION_SECRET?: string;
}

/** Server-only façade. It owns activation and never returns a raw Lunora client or namespace stub. */
export const catalogHomes = (namespace: CatalogHomeNamespace, env: CatalogHomesEnv) => {
  const localWorkerd = env.LOCAL_WORKERD === "1";
  const ids = catalogHomeNamespace(namespace, localWorkerd);
  const relaySecret = catalogRelaySecret({ ...env, HOMES: namespace } as Parameters<
    typeof catalogRelaySecret
  >[0]);

  return {
    personal(input: typeof CatalogPersonalRoot.Type) {
      const home = decodePersonalRoot(input);
      const homeKey = catalogHomeKey(home);
      let bound: Promise<void> | undefined;
      let activation: Promise<void> | undefined;
      const systemClient = () =>
        createShardClient(namespace as unknown as ShardNamespaceLike, {
          shardKey: homeKey,
          system: true,
          ...(localWorkerd ? {} : { jurisdiction: "eu" as const }),
        });
      const userClient = (actor: typeof CatalogPolicyActor.Type) =>
        createShardClient(namespace as unknown as ShardNamespaceLike, {
          shardKey: homeKey,
          system: false,
          ...(localWorkerd ? {} : { jurisdiction: "eu" as const }),
        }).as({ userId: actor.userId, claims: { catalogHomeKey: homeKey } });

      const bind = async () => {
        const response = await ids
          .get(ids.idFromName(homeKey))
          .fetch(`https://catalog.internal${CATALOG_HOME_BIND_PATH}`, {
            method: "POST",
            headers: {
              [CATALOG_HOME_BIND_HEADER]: relaySecret,
              "content-type": "application/json",
            },
            body: JSON.stringify({ home }),
          });
        if (response.status !== 204) {
          throw new Error("Catalog home activation failed.");
        }
      };

      const ensureBound = () => {
        if (bound === undefined) {
          bound = bind().catch((error: unknown) => {
            bound = undefined;
            throw error;
          });
        }
        return bound;
      };

      const initialize = async () => {
        await ensureBound();
        return systemClient().call(internal.personal.project_initialize, {
          input: { defined: true, value: { incarnation: 1 } },
          operationKey: CATALOG_HOME_INITIALIZATION_OPERATION_KEY,
        });
      };

      const ready = async () => {
        if (activation === undefined) {
          activation = initialize()
            .then((result) => {
              if (result._tag !== "Committed") {
                throw new Error("Catalog home initialization is still pending.");
              }
            })
            .catch((error: unknown) => {
              activation = undefined;
              throw error;
            });
        }
        return activation;
      };

      return {
        initialize,
        view: async (
          actorInput: typeof CatalogPolicyActor.Type,
          query: CatalogQuery,
          resume?: string,
        ) => {
          const actor = decodeActor(actorInput);
          await ready();
          const input = await encodeWireValue(CatalogPolicyTarget, query.input);
          return userClient(actor).call(api.personal.view_access, {
            input,
            ...(resume === undefined ? {} : { resume }),
          });
        },
        change: async (
          actorInput: typeof CatalogPolicyActor.Type,
          command: CatalogCommand,
          operationKey: string,
        ) => {
          const actor = decodeActor(actorInput);
          await ready();
          const client = userClient(actor);
          switch (command.name) {
            case "renameFolder":
              return client.call(api.personal.change_renameFolder, {
                input: await encodeWireValue(CatalogRenameFolder, command.input),
                operationKey,
              });
            case "moveFolder":
              return client.call(api.personal.change_moveFolder, {
                input: await encodeWireValue(CatalogMoveFolder, command.input),
                operationKey,
              });
            case "setGrant":
              return client.call(api.personal.change_setGrant, {
                input: { defined: true, value: command.input },
                operationKey,
              });
          }
        },
      };
    },
  };
};
