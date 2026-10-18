import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import * as Schema from "effect/Schema";

/**
 * How a membership's WorkOS role slugs are stored, wherever they are. Nothing
 * here interprets them: an unknown or custom slug means no more than plain
 * membership.
 */

export const RoleSlugs = Schema.fromJsonString(Schema.Array(Schema.String));
export const encodeRoleSlugs = Schema.encodeSync(RoleSlugs);

/** One spelling per set of slugs, so comparing them is comparing strings. */
export const normalRoleSlugs = (organization: WorkOSOrganization) =>
  encodeRoleSlugs(
    [...new Set(organization.roleSlugs ?? [])].filter((slug) => slug.length > 0).toSorted(),
  );
