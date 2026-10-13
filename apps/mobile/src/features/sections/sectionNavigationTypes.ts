import type { EnvironmentId } from "@t3tools/contracts";

export interface SectionNavigationEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}
