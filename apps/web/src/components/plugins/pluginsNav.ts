/**
 * What the Plugins sidebar lists: section rows with counts, and the search
 * index. Every search result deep-links to its row, group, skill, or preset.
 */
import {
  BookMarkedIcon,
  CableIcon,
  FileTextIcon,
  LayoutGridIcon,
  PuzzleIcon,
  StoreIcon,
  type LucideIcon,
} from "lucide-react";

import { DEFAULTS_PRESETS } from "./defaultsFixtures";
import { GROUPS } from "./groupsFixtures";
import { INSTRUCTION_ROLES, ROLE_INFO } from "./instructionsModel";
import { MARKETPLACE } from "./marketplaceFixtures";
import { HARNESS_PLUGINS, INTEGRATIONS, SKILLS } from "./pluginsFixtures";
import { connectionDisplayName, countSections, type PluginsSection } from "./pluginsModel";
import type { PluginsSearch } from "./pluginsSearch";

/** Groups are listed by name under the nav instead of having their own row. */
export const PLUGINS_NAV: readonly { section: PluginsSection; icon: LucideIcon }[] = [
  { section: "overview", icon: LayoutGridIcon },
  { section: "marketplace", icon: StoreIcon },
  { section: "connections", icon: CableIcon },
  { section: "harness-plugins", icon: PuzzleIcon },
  { section: "skills", icon: BookMarkedIcon },
  { section: "instructions", icon: FileTextIcon },
];

export const PLUGINS_SECTION_COUNTS = countSections({
  integrations: INTEGRATIONS,
  plugins: HARNESS_PLUGINS,
  skills: SKILLS,
  groupCount: GROUPS.length,
  listingCount: MARKETPLACE.length,
});

export type PluginsTarget = PluginsSearch & { readonly section: PluginsSection };

export function pluginsSearch(target: PluginsTarget): PluginsSearch {
  return target.section === "overview" ? {} : target;
}

export interface PluginsSearchEntry {
  readonly key: string;
  readonly label: string;
  readonly target: PluginsTarget;
}

export const PLUGINS_SEARCH_ENTRIES: readonly PluginsSearchEntry[] = [
  ...GROUPS.map((group) => ({
    key: `group:${group.id}`,
    label: `${group.name} group`,
    target: { section: "groups" as const, group: group.id },
  })),
  // Accounts are searchable by the name models see, e.g. "Gmail · Work account".
  ...INTEGRATIONS.flatMap((item) =>
    item.accounts.length > 1
      ? item.accounts.map((account) => ({
          key: `account:${account.id}`,
          label: connectionDisplayName(item, account.label),
          target: { section: "connections" as const, item: item.id },
        }))
      : [],
  ),
  ...INTEGRATIONS.map((item) => ({
    key: `integration:${item.id}`,
    label: item.name,
    target: { section: "connections" as const, item: item.id },
  })),
  ...HARNESS_PLUGINS.map((plugin) => ({
    key: `plugin:${plugin.id}`,
    label: plugin.name,
    target: { section: "harness-plugins" as const, item: plugin.id },
  })),
  ...SKILLS.map((skill) => ({
    key: `skill:${skill.id}`,
    label: skill.name,
    target: { section: "skills" as const, skill: skill.id },
  })),
  ...DEFAULTS_PRESETS.map((preset) => ({
    key: `newcomers:${preset.id}`,
    label: `${preset.name}: what newcomers get`,
    target: {
      section: "groups" as const,
      group: preset.groupId,
      tab: "newcomers" as const,
      item: preset.id,
    },
  })),
  ...INSTRUCTION_ROLES.filter((role) => role !== "assistant").map((role) => ({
    key: `instructions:${role}`,
    label: `${ROLE_INFO[role].label} instructions`,
    target: { section: "instructions" as const, role },
  })),
  ...MARKETPLACE.filter((listing) => listing.kind === "workflow").map((listing) => ({
    key: `workflow:${listing.id}`,
    label: listing.name,
    target: { section: "marketplace" as const, item: listing.id },
  })),
];
