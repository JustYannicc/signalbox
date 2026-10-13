/**
 * PLACEHOLDER DATA. A mapping puts one place inside a connected account (a
 * Drive folder, a Slack channel, a Confluence page tree) into a Home folder,
 * the way a project folder holds what it needs. It lives in one folder and
 * other folders can reference it. Whatever no mapping covers stays loose in
 * its account, which sits at the level it is connected at (see `mappedItems`).
 */
import type { Reach } from "../levels/levels";
import type { SpacesItemFixture } from "./spacesFixtures";
import { findSource } from "./spacesModel";

/**
 * Where a mapping or automation lives (or is referenced) by default: a Home container key, or the
 * first real project whose name or path contains one of `projectNamed`
 * (fixtures can't know real project keys), else `fallback`.
 */
export type HomeTarget =
  | string
  | { readonly projectNamed: readonly string[]; readonly fallback: string };

export interface SpacesMapping {
  readonly id: string;
  /** A source id from SPACES_SOURCES: the connected account it lives in. */
  readonly source: string;
  readonly name: string;
  /** What the place is in its app: "Folder", "Channel", "Page tree". */
  readonly what: string;
  /** Item locations under any of these prefixes belong to the mapping. */
  readonly locations: readonly string[];
  /** The one folder it lives in. */
  readonly home: HomeTarget;
  /** Other folders that show it as a reference, and whose agents may use it. */
  readonly references?: readonly HomeTarget[];
  /** `below` lets every folder inside its home use it; defaults to `here`. */
  readonly reach?: Reach;
}

/** The fork's own repo, whatever the user named the project. */
export const T3CODE_PROJECT: HomeTarget = {
  projectNamed: ["signalbox", "t3code"],
  fallback: "section:personal",
};

export const SPACES_MAPPINGS: readonly SpacesMapping[] = [
  {
    id: "drive-t3code",
    source: "drive",
    name: "T3 Code",
    what: "Folder",
    locations: ["My Drive / T3 Code"],
    home: T3CODE_PROJECT,
  },
  {
    id: "github-fork",
    source: "github",
    name: "JustYannicc/t3code",
    what: "Repository",
    locations: ["JustYannicc/t3code"],
    home: T3CODE_PROJECT,
  },
  {
    id: "drive-admin",
    source: "drive",
    name: "Admin",
    what: "Folder",
    locations: ["My Drive / Admin"],
    home: "section:personal",
    // Card receipts live here; the Work agent files the expense report from them.
    references: ["section:work"],
  },
  {
    id: "notion-reading",
    source: "notion",
    name: "Reading",
    what: "Page tree",
    locations: ["Reading"],
    home: "section:personal",
  },
  {
    id: "northwind-drive-terminal",
    source: "northwind-drive",
    name: "Terminal",
    what: "Shared drive",
    locations: ["Shared drives / Terminal"],
    // The team's drive, referenced from the project that lives off it.
    home: "section:work-northwind",
    references: ["team-project:terminal-app"],
  },
  {
    id: "slack-northwind-eng",
    source: "slack",
    name: "#northwind-eng",
    what: "Channel",
    locations: ["#northwind-eng"],
    // The whole team's channel: every project inside Northwind team can use it.
    home: "section:work-northwind",
    reach: "below",
  },
  {
    id: "slack-terminal-team",
    source: "slack",
    name: "#terminal-team",
    what: "Channel",
    locations: ["#terminal-team"],
    home: "team-project:terminal-app",
  },
  {
    id: "confluence-term",
    source: "confluence",
    name: "TERM",
    what: "Space",
    locations: ["TERM"],
    home: "team-project:terminal-app",
  },
  {
    id: "jira-term",
    source: "jira",
    name: "TERM",
    what: "Project",
    locations: ["TERM-"],
    home: "team-project:terminal-app",
  },
  {
    id: "sentry-terminal-app",
    source: "sentry",
    name: "terminal-app",
    what: "Project",
    locations: ["terminal-app"],
    home: "team-project:terminal-app",
  },
];

export function findMapping(mappingId: string | undefined): SpacesMapping | undefined {
  return SPACES_MAPPINGS.find((mapping) => mapping.id === mappingId);
}

export function mappingCovers(mapping: SpacesMapping, item: SpacesItemFixture): boolean {
  return (
    item.source === mapping.source &&
    mapping.locations.some((prefix) => item.location.startsWith(prefix))
  );
}

/**
 * Items no mapped place covers: they show on their account's own page. Pass the
 * mappings that still have a home, so an unmapped place's items come back loose.
 */
export function isLoose(
  item: SpacesItemFixture,
  mappings: readonly SpacesMapping[] = SPACES_MAPPINGS,
): boolean {
  return !mappings.some((mapping) => mappingCovers(mapping, item));
}

/** The account's sync state, plus its problem when the account failed. */
export function mappingHealth(mapping: SpacesMapping) {
  const source = findSource(mapping.source);
  return {
    connector: source?.connector ?? "notes",
    accountName: source?.name ?? mapping.source,
    failed: source?.sync === "error",
    problem: source?.problem ?? null,
  };
}
