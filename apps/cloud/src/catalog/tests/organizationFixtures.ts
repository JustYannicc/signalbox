import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { catalogOrganizationRoot } from "../catalogOrganizationRoot.ts";
import { CatalogPolicyFailure } from "../catalogPolicy.ts";
import { organizationHome } from "./organizationContext.ts";

export const org = catalogOrganizationRoot;
export const top = { folderId: null, incarnation: 1 } as const;

export const openState = (home = organizationHome(), extra = {}) => ({
  key: "state",
  level: { home, incarnation: 1 },
  revision: 0,
  storageState: "open",
  ...extra,
});
export const freshRoot = (extra = {}) => ({
  key: "root",
  topologyRevision: 0,
  authEpoch: 0,
  ...extra,
});
export const member = (
  personId: string,
  roleSlugs: ReadonlyArray<string> | null,
  sourceRevision = 1,
  incarnation = 1,
) => ({ personId, incarnation, sourceRevision, roleSlugs });

export const bootstrapped = (extra: { state?: object; root?: object } = {}) => ({
  state: [openState(organizationHome(), extra.state)],
  root: [freshRoot(extra.root)],
});

export const delivery = (
  personId: string,
  sourceRevision: number,
  roleSlugs: ReadonlyArray<string> | null,
  incarnation = 1,
) => ({ incarnation, personId, sourceRevision, roleSlugs });

const failsWith =
  (reason: "denied" | "invalid_state") =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toEqual(new CatalogPolicyFailure({ reason }))),
    );
export const denied = failsWith("denied");
export const invalidState = failsWith("invalid_state");
