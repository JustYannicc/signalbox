/**
 * The /plugins search params. Every param belongs to one section; anything
 * unknown, invalid, or on the wrong section is dropped, so a stale link
 * lands on the section instead of a broken detail.
 */
import * as Option from "effect/Option";

import type { LevelTab } from "./LevelDetail";
import { INSTRUCTION_AUDIENCES } from "./instructionsModel";
import type { InstructionAudience } from "./instructionsModel";
import type { MarketplaceKindFilter } from "./MarketplaceSection";
import { decodePluginsSection, type PluginsSection } from "./pluginsModel";

export interface PluginsSearch {
  section?: PluginsSection;
  /**
   * Levels: the open level's key (e.g. "section:work-northwind"), its tab, and
   * (newcomers tab) the selected preset. Named `group` for older links.
   */
  group?: string;
  tab?: Extract<LevelTab, "newcomers">;
  /** Skills: the open skill. */
  skill?: string;
  /** Connections, plugins, marketplace, newcomers: the row to expand and highlight. */
  item?: string;
  /** Instructions: the level whose AGENTS.md is open, and for whom. */
  level?: string;
  audience?: InstructionAudience;
  /** Marketplace: workflows or skills only. */
  kind?: Exclude<MarketplaceKindFilter, "all">;
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function oneOf<T extends string>(options: readonly T[], value: unknown) {
  return options.find((option) => option === value);
}

export function parsePluginsSearch(raw: Record<string, unknown>): PluginsSearch {
  const decoded = decodePluginsSection(raw.section);
  if (Option.isNone(decoded) || decoded.value === "overview") return {};
  const section = decoded.value;
  const keep = <K extends keyof PluginsSearch>(key: K, value: PluginsSearch[K] | undefined) =>
    value === undefined ? {} : { [key]: value };

  switch (section) {
    case "levels": {
      const group = text(raw.group);
      const tab = group && raw.tab === "newcomers" ? "newcomers" : undefined;
      return {
        section,
        ...keep("group", group),
        ...keep("tab", tab),
        ...keep("item", tab ? text(raw.item) : undefined),
      };
    }
    case "skills":
      return { section, ...keep("skill", text(raw.skill)) };
    case "instructions":
      return {
        section,
        ...keep("level", text(raw.level)),
        ...keep("audience", oneOf(INSTRUCTION_AUDIENCES, raw.audience)),
      };
    case "marketplace":
      return {
        section,
        ...keep("kind", oneOf(["workflows", "skills"] as const, raw.kind)),
        ...keep("item", text(raw.item)),
      };
    case "connections":
    case "harness-plugins":
      return { section, ...keep("item", text(raw.item)) };
  }
}
