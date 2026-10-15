/**
 * How full production's container applications are, read from the Containers
 * API's application list (`GET /accounts/<id>/containers/applications`).
 * Past `max_instances` a container can't start: a pool stops answering and a
 * turn fails with "No machine came up", so we want to hear well before that.
 */

import { cloudStage } from "./stage.ts";

/** The share of `max_instances` in use at which we open an alert. */
export const NEAR_CAP_SHARE = 0.8;

/** The fields of a Containers API application this reads. */
export interface ContainerApplication {
  readonly name: string;
  readonly max_instances: number;
  readonly health?: {
    readonly instances?: { readonly active?: number; readonly assigned?: number };
  };
}

export interface CapacityRow {
  readonly name: string;
  readonly inUse: number;
  readonly max: number;
  readonly nearCap: boolean;
}

const production = cloudStage("production");

/** Production's applications, the only ones people depend on. */
export const WATCHED_APPLICATIONS = [
  production.poolContainer.name,
  production.threadContainer.name,
];

/**
 * In use is `active + assigned`, Cloudflare's estimate of instances bound to a
 * Durable Object (`active` alone undercounts ones still starting). A watched
 * application that's missing throws: a renamed one would leave us blind.
 */
export const containerCapacity = (
  applications: ReadonlyArray<ContainerApplication>,
  names: ReadonlyArray<string> = WATCHED_APPLICATIONS,
): ReadonlyArray<CapacityRow> =>
  names.map((name) => {
    const application = applications.find((candidate) => candidate.name === name);
    if (application === undefined) {
      throw new Error(`No container application named "${name}".`);
    }
    const instances = application.health?.instances;
    const inUse = (instances?.active ?? 0) + (instances?.assigned ?? 0);
    const max = application.max_instances;
    return { name, inUse, max, nearCap: inUse >= max * NEAR_CAP_SHARE };
  });
