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
import type { catalogHomeClient } from "./catalogHomeClient.ts";
import {
  CatalogMembershipDelivery,
  CatalogOrganizationBootstrap,
} from "../catalogOrganizationPolicy.ts";

export type CatalogOrganizationProjection =
  | { readonly name: "bootstrap"; readonly input: typeof CatalogOrganizationBootstrap.Type }
  | { readonly name: "syncMembership"; readonly input: typeof CatalogMembershipDelivery.Type };
export type CatalogOrganizationQuery =
  | { readonly name: "access"; readonly input: typeof CatalogPolicyTarget.Type }
  | { readonly name: "children"; readonly input: typeof CatalogListChildren.Type };
export type CatalogOrganizationCommand =
  | { readonly name: "createFolder"; readonly input: typeof CatalogCreateFolder.Type }
  | { readonly name: "retireFolder"; readonly input: typeof CatalogFolderLifecycle.Type }
  | { readonly name: "reopenFolder"; readonly input: typeof CatalogFolderLifecycle.Type }
  | { readonly name: "renameFolder"; readonly input: typeof CatalogRenameFolder.Type }
  | { readonly name: "moveFolder"; readonly input: typeof CatalogMoveFolder.Type }
  | { readonly name: "setGrant"; readonly input: typeof CatalogSetGrant.Type };

const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);
export const organizationCatalogHome = (connection: ReturnType<typeof catalogHomeClient>) => {
  const ready = connection.bound;
  return {
    project: async (delivery: CatalogOrganizationProjection, operationKey: string) => {
      await connection.bound();
      switch (delivery.name) {
        case "bootstrap":
          return connection.system().call(internal.organization.project_bootstrap, {
            input: await encodeWireValue(CatalogOrganizationBootstrap, delivery.input),
            operationKey,
          });
        case "syncMembership":
          return connection.system().call(internal.organization.project_syncMembership, {
            input: await encodeWireValue(CatalogMembershipDelivery, delivery.input),
            operationKey,
          });
      }
    },
    view: async (
      actorInput: typeof CatalogPolicyActor.Type,
      query: CatalogOrganizationQuery,
      resume?: string,
    ) => {
      const actor = decodeActor(actorInput);
      await ready();
      const client = connection.user(actor);
      switch (query.name) {
        case "access":
          return client.call(api.organization.view_access, {
            input: await encodeWireValue(CatalogPolicyTarget, query.input),
            ...(resume === undefined ? {} : { resume }),
          });
        case "children":
          return client.call(api.organization.view_children, {
            input: await encodeWireValue(CatalogListChildren, query.input),
            ...(resume === undefined ? {} : { resume }),
          });
      }
    },
    change: async (
      actorInput: typeof CatalogPolicyActor.Type,
      command: CatalogOrganizationCommand,
      operationKey: string,
    ) => {
      const actor = decodeActor(actorInput);
      await ready();
      const client = connection.user(actor);
      switch (command.name) {
        case "createFolder":
          return client.call(api.organization.change_createFolder, {
            input: await encodeWireValue(CatalogCreateFolder, command.input),
            operationKey,
          });
        case "retireFolder":
          return client.call(api.organization.change_retireFolder, {
            input: await encodeWireValue(CatalogFolderLifecycle, command.input),
            operationKey,
          });
        case "reopenFolder":
          return client.call(api.organization.change_reopenFolder, {
            input: await encodeWireValue(CatalogFolderLifecycle, command.input),
            operationKey,
          });
        case "renameFolder":
          return client.call(api.organization.change_renameFolder, {
            input: await encodeWireValue(CatalogRenameFolder, command.input),
            operationKey,
          });
        case "moveFolder":
          return client.call(api.organization.change_moveFolder, {
            input: await encodeWireValue(CatalogMoveFolder, command.input),
            operationKey,
          });
        case "setGrant":
          return client.call(api.organization.change_setGrant, {
            input: await encodeWireValue(CatalogSetGrant, command.input),
            operationKey,
          });
      }
    },
  };
};
