import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { RpcPermissionGuard } from "./client.ts";
import { createCommandPermissions } from "../state/commandPermissions.ts";

export const withEnvironmentCommandPermissions = <R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.provideService(RpcPermissionGuard, {
    authorize: (environmentId, method, input) =>
      createCommandPermissions(runtime, method).authorize(registry, environmentId, input),
  });
