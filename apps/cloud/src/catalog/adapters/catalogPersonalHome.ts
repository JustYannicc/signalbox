import * as Schema from "effect/Schema";
import { encodeWireValue } from "@signalbox/sync/adapters/lunoraWireValue";
import { api } from "../lunora/_generated/api.js";
import { internal } from "../lunora/_generated/internal.js";
import { CatalogPolicyActor, CatalogPolicyTarget } from "../catalogPolicy.ts";
import { CatalogSetGrant } from "./catalogGrant.ts";
import {
  CatalogCreateFolder,
  CatalogFolderLifecycle,
  CatalogListChildren,
} from "./catalogLifecycle.ts";
import { CatalogMoveFolder, CatalogRenameFolder } from "./catalogTopology.ts";
import {
  CATALOG_HOME_INITIALIZATION_OPERATION_KEY,
  type catalogHomeClient,
} from "./catalogHomeClient.ts";
import {
  CatalogEnsureOrganizationReference,
  CatalogListReferencePlacements,
  CatalogMoveOrganizationReference,
} from "../catalogOrganizationReferences.ts";

export type CatalogPersonalProjection = {
  readonly name: "ensureOrganizationReference";
  readonly input: typeof CatalogEnsureOrganizationReference.Type;
};
export type CatalogPersonalQuery =
  | { readonly name: "access"; readonly input: typeof CatalogPolicyTarget.Type }
  | { readonly name: "children"; readonly input: typeof CatalogListChildren.Type }
  | {
      readonly name: "referencePlacements";
      readonly input: typeof CatalogListReferencePlacements.Type;
    };
export type CatalogPersonalCommand =
  | { readonly name: "createFolder"; readonly input: typeof CatalogCreateFolder.Type }
  | { readonly name: "retireFolder"; readonly input: typeof CatalogFolderLifecycle.Type }
  | { readonly name: "reopenFolder"; readonly input: typeof CatalogFolderLifecycle.Type }
  | { readonly name: "renameFolder"; readonly input: typeof CatalogRenameFolder.Type }
  | { readonly name: "moveFolder"; readonly input: typeof CatalogMoveFolder.Type }
  | { readonly name: "setGrant"; readonly input: typeof CatalogSetGrant.Type }
  | {
      readonly name: "moveOrganizationReference";
      readonly input: typeof CatalogMoveOrganizationReference.Type;
    };

const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);
export const personalCatalogHome = (connection: ReturnType<typeof catalogHomeClient>) => {
  let activation: Promise<void> | undefined;
  const initialize = async () => {
    await connection.bound();
    return connection.system().call(internal.personal.project_initialize, {
      input: { defined: true, value: { incarnation: 1 } },
      operationKey: CATALOG_HOME_INITIALIZATION_OPERATION_KEY,
    });
  };
  const ready = () => {
    activation ??= initialize()
      .then((result) => {
        if (result._tag !== "Committed")
          throw new Error("Catalog home initialization is still pending.");
      })
      .catch((error: unknown) => {
        activation = undefined;
        throw error;
      });
    return activation;
  };
  return {
    initialize,
    project: async (delivery: CatalogPersonalProjection, operationKey: string) => {
      await ready();
      switch (delivery.name) {
        case "ensureOrganizationReference":
          return connection.system().call(internal.personal.project_ensureOrganizationReference, {
            input: await encodeWireValue(CatalogEnsureOrganizationReference, delivery.input),
            operationKey,
          });
      }
    },
    view: async (
      actorInput: typeof CatalogPolicyActor.Type,
      query: CatalogPersonalQuery,
      resume?: string,
    ) => {
      const actor = decodeActor(actorInput);
      await ready();
      const client = connection.user(actor);
      switch (query.name) {
        case "access":
          return client.call(api.personal.view_access, {
            input: await encodeWireValue(CatalogPolicyTarget, query.input),
            ...(resume === undefined ? {} : { resume }),
          });
        case "children":
          return client.call(api.personal.view_children, {
            input: await encodeWireValue(CatalogListChildren, query.input),
            ...(resume === undefined ? {} : { resume }),
          });
        case "referencePlacements":
          return client.call(api.personal.view_referencePlacements, {
            input: await encodeWireValue(CatalogListReferencePlacements, query.input),
            ...(resume === undefined ? {} : { resume }),
          });
      }
    },
    change: async (
      actorInput: typeof CatalogPolicyActor.Type,
      command: CatalogPersonalCommand,
      operationKey: string,
    ) => {
      const actor = decodeActor(actorInput);
      await ready();
      const client = connection.user(actor);
      switch (command.name) {
        case "createFolder":
          return client.call(api.personal.change_createFolder, {
            input: await encodeWireValue(CatalogCreateFolder, command.input),
            operationKey,
          });
        case "retireFolder":
          return client.call(api.personal.change_retireFolder, {
            input: await encodeWireValue(CatalogFolderLifecycle, command.input),
            operationKey,
          });
        case "reopenFolder":
          return client.call(api.personal.change_reopenFolder, {
            input: await encodeWireValue(CatalogFolderLifecycle, command.input),
            operationKey,
          });
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
            input: await encodeWireValue(CatalogSetGrant, command.input),
            operationKey,
          });
        case "moveOrganizationReference":
          return client.call(api.personal.change_moveOrganizationReference, {
            input: await encodeWireValue(CatalogMoveOrganizationReference, command.input),
            operationKey,
          });
      }
    },
  };
};
