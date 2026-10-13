/**
 * PLACEHOLDER DATA for who runs which level. Northwind's admins run Work ›
 * Northwind team and its projects; every other level is yours. Delete with
 * pluginsFixtures.ts once levels are real.
 */
import { GROUP_LEVEL, levelLabel } from "../levels/levels";
import { accountGroupsFromLevels, type LevelPolicy } from "./levelPolicyModel";

export const LEVEL_POLICIES: readonly LevelPolicy[] = [
  {
    level: "section:work-northwind",
    yourRole: "Member",
    org: { name: "Northwind", domain: "northwind.example" },
    restricted: { connections: "admins", models: "admins", defaults: "admins" },
  },
];

/** The organization's level; publishing a skill places it there for everyone in it. */
export const ORG_POLICY: LevelPolicy | undefined = LEVEL_POLICIES[0];

/** Who Usage › Accounts can share a pool with as a group (people, not agents). */
export const ACCOUNT_GROUPS_FROM_PLUGINS = accountGroupsFromLevels(GROUP_LEVEL, (level) =>
  levelLabel(level),
);
