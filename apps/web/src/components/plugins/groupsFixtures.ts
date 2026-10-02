/**
 * PLACEHOLDER DATA for access groups. Section names come from the Home
 * sidebar's sections and model accounts from Usage › Accounts, so the three
 * surfaces agree. Delete with pluginsFixtures.ts once groups are real.
 */
import { POOL_ACCOUNTS } from "../accounts/accountPoolsFixtures";
import { sectionPathLabel } from "../sidebar/sections/sectionModel";
import {
  accountGroupsFromAccessGroups,
  type AccessGroup,
  type SectionGroupUsage,
} from "./groupsModel";
import { HARNESS_PLUGINS, INTEGRATIONS, SKILLS } from "./pluginsFixtures";

export const GROUPS: readonly AccessGroup[] = [
  {
    id: "northwind",
    name: "Northwind",
    description: "Everything for work. Agents in Northwind sections only reach Northwind accounts.",
    yourRole: "Member",
    org: "northwind.example",
    restricted: { connections: "admins", models: "admins", defaults: "admins" },
  },
  {
    id: "personal",
    name: "Personal",
    description: "Your own accounts, projects, and subscriptions.",
    yourRole: "Owner",
    restricted: {},
  },
];

/** Keyed by Home section id (see sidebar/sections/sectionModel.ts). */
export const SECTION_GROUP_USAGE: readonly SectionGroupUsage[] = [
  { sectionId: "work", groups: ["northwind"], overrides: 1 },
  { sectionId: "work-northwind", groups: ["northwind"], overrides: 2 },
  { sectionId: "personal", groups: ["personal"], overrides: 1 },
];

export const GROUP_SOURCES = {
  integrations: INTEGRATIONS,
  models: POOL_ACCOUNTS,
  skills: SKILLS,
  plugins: HARNESS_PLUGINS,
};

/** What Usage › Accounts can read instead of its own ACCOUNT_GROUPS fixture. */
export const ACCOUNT_GROUPS_FROM_PLUGINS = accountGroupsFromAccessGroups(
  GROUPS,
  SECTION_GROUP_USAGE,
  sectionPathLabel,
);
