import * as Schema from "effect/Schema";

import { catalogHomeClient, type CatalogHomesEnv } from "./adapters/catalogHomeClient.ts";
import { personalCatalogHome } from "./adapters/catalogPersonalHome.ts";
import { organizationCatalogHome } from "./adapters/catalogOrganizationHome.ts";
import { CatalogPersonalRoot } from "./catalogPolicy.ts";
import { CatalogOrganizationRoot } from "./catalogOrganizationPolicy.ts";
import type { CatalogHomeNamespace } from "./catalogObjects.ts";

export type { CatalogHomesEnv } from "./adapters/catalogHomeClient.ts";
export type { CatalogPersonalProjection } from "./adapters/catalogPersonalHome.ts";
export type { CatalogOrganizationProjection } from "./adapters/catalogOrganizationHome.ts";
export { CATALOG_HOME_INITIALIZATION_OPERATION_KEY } from "./adapters/catalogHomeClient.ts";
export type {
  CatalogPersonalQuery as CatalogQuery,
  CatalogPersonalCommand as CatalogCommand,
  CatalogPersonalQuery,
  CatalogPersonalCommand,
} from "./adapters/catalogPersonalHome.ts";
export type {
  CatalogOrganizationQuery,
  CatalogOrganizationCommand,
} from "./adapters/catalogOrganizationHome.ts";
const decodePersonal = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeOrganization = Schema.decodeUnknownSync(CatalogOrganizationRoot);

/** Server-only facade. Activation and trusted projections never expose raw namespace clients. */
export const catalogHomes = (namespace: CatalogHomeNamespace, env: CatalogHomesEnv) => ({
  personal(input: typeof CatalogPersonalRoot.Type) {
    return personalCatalogHome(catalogHomeClient(namespace, env, decodePersonal(input)));
  },
  organization(input: typeof CatalogOrganizationRoot.Type) {
    return organizationCatalogHome(catalogHomeClient(namespace, env, decodeOrganization(input)));
  },
});
