import { describe, expect, it } from "vite-plus/test";

import { AUTOMATIONS } from "../../homeAutomations/automationFixtures";
import { SKILLS } from "../../levels/leveledThings";
import { SPACES_ITEMS } from "../../spaces/spacesFixtures";
import { isLoose } from "../../spaces/spacesMappings";
import {
  AUTOMATION_HOMES,
  activeMappings,
  buildMappedIndex,
  migrateMapped,
  type MappedOverrides,
} from "./mappedItems";

const overrides = (partial: Partial<MappedOverrides>): MappedOverrides => ({
  homes: {},
  references: {},
  reach: {},
  ...partial,
});

const idsIn = (index: ReturnType<typeof buildMappedIndex>, key: string) =>
  (index.byContainer.get(key) ?? []).map((item) => item.id);

const signalbox = {
  projectKey: "env:signalbox",
  displayName: "signalbox",
  workspaceRoot: "/Users/me/Desktop/Personal_Projects/signalbox",
};

describe("buildMappedIndex", () => {
  it("puts project automations and places in the matching real project", () => {
    const index = buildMappedIndex({
      automations: AUTOMATIONS,
      projects: [signalbox],
    });
    const inProject = idsIn(index, "project:env:signalbox");
    expect(inProject).toContain("automation:sync-upstream");
    expect(inProject).toContain("place:drive-t3code");
  });

  it("falls back to the section when no project matches", () => {
    const index = buildMappedIndex({ automations: AUTOMATIONS, projects: [] });
    expect(idsIn(index, "section:personal")).toContain("automation:sync-upstream");
  });

  it("shows a referenced place in its home and the referencing folder", () => {
    const index = buildMappedIndex({ automations: [], projects: [] });
    const id = "place:northwind-drive-terminal";
    expect(idsIn(index, "section:work-northwind")).toContain(id);
    expect(idsIn(index, "team-project:terminal-app")).toContain(id);
    expect(index.homeById.get(id)).toBe("section:work-northwind");
    expect(index.referencesById.get(id)).toEqual(["team-project:terminal-app"]);
    expect(index.homesById.get(id)).toEqual([
      "section:work-northwind",
      "team-project:terminal-app",
    ]);
  });

  it("lets the user move, unmap and re-reference places", () => {
    const index = buildMappedIndex({
      automations: [],
      projects: [],
      overrides: overrides({
        homes: { "place:drive-admin": null, "place:notion-reading": "section:work" },
        references: { "place:notion-reading": ["section:personal", "section:work"] },
      }),
    });
    expect(index.homesById.get("place:drive-admin")).toEqual([]);
    expect(idsIn(index, "section:personal")).not.toContain("place:drive-admin");
    expect(index.homeById.get("place:notion-reading")).toBe("section:work");
    // A reference to its own home is dropped.
    expect(index.referencesById.get("place:notion-reading")).toEqual(["section:personal"]);
  });

  it("gives automations one home and no references", () => {
    const index = buildMappedIndex({
      automations: AUTOMATIONS,
      projects: [],
      overrides: overrides({
        homes: { "automation:water-plants": null },
        references: { "automation:water-plants": ["section:work"] },
      }),
    });
    // Only a place can be unmapped; an automation falls back to its default home.
    expect(index.homesById.get("automation:water-plants")).toEqual(["section:personal"]);
  });

  it("reads reach, defaulting to here", () => {
    const index = buildMappedIndex({
      automations: [],
      projects: [],
      overrides: overrides({ reach: { "account:slack": "below" } }),
    });
    expect(index.reachById.get("account:slack")).toBe("below");
    expect(index.reachById.get("place:drive-admin")).toBe("here");
  });

  it("doesn't match a project that only sits inside the repo's path", () => {
    const server = {
      projectKey: "env:server",
      displayName: "server",
      workspaceRoot: "/Users/me/Desktop/Personal_Projects/signalbox/apps/server",
    };
    const index = buildMappedIndex({
      automations: AUTOMATIONS,
      projects: [server],
    });
    expect(index.byContainer.get("project:env:server")).toBeUndefined();
  });

  it("homes every automation from the table, built-ins and guards at the top level", () => {
    expect(AUTOMATIONS.filter((automation) => !(automation.id in AUTOMATION_HOMES))).toEqual([]);
    const index = buildMappedIndex({ automations: AUTOMATIONS, projects: [] });
    const root = idsIn(index, "root");
    for (const id of ["capture-routing", "danger-check", "no-force-push"]) {
      expect(root).toContain(`automation:${id}`);
    }
  });

  it("puts what needs you first", () => {
    const index = buildMappedIndex({ automations: [], projects: [] });
    // Sentry's account failed to sync, so its place leads the project's list.
    expect(idsIn(index, "team-project:terminal-app")[0]).toBe("place:sentry-terminal-app");
  });

  it("puts each account at the level it is connected at, ahead of the places in it", () => {
    const index = buildMappedIndex({ automations: [], projects: [] });
    const personal = idsIn(index, "section:personal");
    expect(personal).toContain("account:drive");
    expect(personal).toContain("account:notes");
    expect(personal.indexOf("account:drive")).toBeLessThan(personal.indexOf("place:drive-admin"));
    expect(idsIn(index, "section:work")).toContain("account:work-notes");
    expect(idsIn(index, "section:work-northwind")).toContain("account:slack");
    expect(idsIn(index, "section:work-northwind")).not.toContain("account:drive");
  });

  it("breaks a failed account out as needing you", () => {
    const index = buildMappedIndex({ automations: [], projects: [] });
    const sentry = index.byContainer
      .get("section:work-northwind")
      ?.find((item) => item.id === "account:sentry");
    expect(sentry?.status).toBe("failed");
    expect(idsIn(index, "section:work-northwind")[0]).toBe("account:sentry");
  });
});

describe("isLoose", () => {
  const byId = (id: string) => SPACES_ITEMS.find((item) => item.id === id)!;

  it("is false for items inside a mapped place and true for the rest", () => {
    expect(isLoose(byId("drive-release-checklist"))).toBe(false);
    expect(isLoose(byId("jira-card-timeout"))).toBe(false);
    expect(isLoose(byId("gmail-transit-renewal"))).toBe(true);
    expect(isLoose(byId("drive-dither-talk"))).toBe(true);
  });

  it("gives an unmapped place's items back to its account", () => {
    const mappings = activeMappings({ "place:drive-admin": null });
    expect(isLoose(byId("drive-finances"))).toBe(false);
    expect(isLoose(byId("drive-finances"), mappings)).toBe(true);
    expect(isLoose(byId("drive-release-checklist"), mappings)).toBe(false);
  });
});

describe("skills in the strip", () => {
  const skill = SKILLS[0]!;

  it("sit at every level Plugins places them, and nowhere without one", () => {
    const index = buildMappedIndex({
      automations: [],
      projects: [],
      skills: {
        list: SKILLS,
        levels: new Map([[skill.id, ["root", "section:work-northwind"]]]),
      },
    });
    const id = `skill:${skill.id}`;
    expect(index.byContainer.get("root")?.map((item) => item.id)).toContain(id);
    expect(index.byContainer.get("section:work-northwind")?.map((item) => item.id)).toContain(id);
    const placed = [...index.byContainer.values()].flat().filter((item) => item.kind === "skill");
    expect(placed.map((item) => item.id)).toEqual([id, id]);
  });
});

describe("migrateMapped", () => {
  it("keeps the first of many homes and turns the rest into references", () => {
    const migrated = migrateMapped(
      {
        homes: {
          "place:northwind-drive-terminal": ["team-project:terminal-app", "section:work"],
          "place:drive-admin": [],
          "account:slack": ["section:work", "section:work-northwind"],
          "automation:danger-check": ["system", "section:work"],
        },
        openStrips: { root: true },
      },
      2,
    );
    expect(migrated.homes).toEqual({
      "place:northwind-drive-terminal": "team-project:terminal-app",
      "place:drive-admin": null,
      "account:slack": "section:work",
      "automation:danger-check": "root",
    });
    expect(migrated.references).toEqual({
      "place:northwind-drive-terminal": ["section:work"],
      "place:drive-admin": [],
      "account:slack": ["section:work-northwind"],
    });
    expect(migrated.openStrips).toEqual({ root: true });
  });

  it("renames v1's source ids to places", () => {
    const migrated = migrateMapped({ homes: { "source:drive-admin": ["section:work"] } }, 1);
    expect(migrated.homes).toEqual({ "place:drive-admin": "section:work" });
  });
});
