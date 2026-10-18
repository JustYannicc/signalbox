import type { AuthorizationFence } from "@signalbox/sync/definition";
import { LunoraError } from "lunorash/errors";
import { defineEnv, v } from "lunorash/server";
import type { ShardClient } from "lunorash/runtime";

import { CatalogRootHome } from "../catalogHomeSchema.ts";

export interface CatalogRuntimePorts {
  readonly home: () => Promise<typeof CatalogRootHome.Type>;
  readonly currentEpoch: () => number;
  readonly install: (fence: AuthorizationFence) => Promise<void>;
  readonly client: () => ShardClient;
}

/** The DO constructor injects this private port object into Lunora's handler env. */
export const env = defineEnv({ CATALOG_RUNTIME: v.any() });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCatalogRuntimePorts = (value: unknown): value is CatalogRuntimePorts =>
  isRecord(value) &&
  typeof value.home === "function" &&
  typeof value.currentEpoch === "function" &&
  typeof value.install === "function" &&
  typeof value.client === "function";

export const runtimePorts = (environment: unknown): CatalogRuntimePorts => {
  const ports = isRecord(environment) ? environment.CATALOG_RUNTIME : undefined;
  if (!isCatalogRuntimePorts(ports)) {
    throw new LunoraError("INTERNAL_SERVER_ERROR", "Catalog runtime bindings are unavailable.");
  }
  return ports;
};
