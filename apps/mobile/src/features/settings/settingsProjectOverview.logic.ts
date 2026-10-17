import type { EnvironmentId } from "@t3tools/contracts";

interface ProjectCheckout {
  readonly environmentId: EnvironmentId;
}

interface CheckoutEnvironment {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: { readonly localFilesystem?: boolean };
    };
  };
}

/** Keep machine checkout details only for environments with a user-reachable filesystem. */
export function visibleProjectCheckouts<Project extends ProjectCheckout>(
  projects: readonly Project[],
  environments: readonly CheckoutEnvironment[],
): readonly Project[] {
  const visibleEnvironmentIds = new Set(
    environments
      .filter(
        (environment) =>
          environment.serverConfig.environment.capabilities.localFilesystem !== false,
      )
      .map((environment) => environment.environmentId),
  );
  return projects.filter((project) => visibleEnvironmentIds.has(project.environmentId));
}
