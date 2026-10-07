import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import type { SectionId, SectionsSnapshot } from "@t3tools/contracts/sections";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  projectDefaultModelSelectionWithSectionPool,
  sectionDefaultPoolId,
} from "./sectionPoolDefault.ts";

const provider = (instanceId: string, driver: string, models: ReadonlyArray<string>) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    models: models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
  }) as unknown as ServerProvider;

const providers = [
  provider("claude_hub", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
  provider("codex_hub", "codex", ["gpt-6-astra"]),
  provider("claude_hub_work", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
  provider("codex_hub_lab", "codex", ["gpt-6-astra"]),
];

const hub = (driver: string, poolId?: string) => ({
  driver: ProviderDriverKind.make(driver),
  config: { setupMode: "hub", ...(poolId ? { poolId } : {}) },
});

const section = (id: string, parentId: string | null, defaultPoolId?: string) => ({
  id: id as SectionId,
  name: id,
  parentId: parentId as SectionId | null,
  position: 0,
  ...(defaultPoolId ? { defaultPoolId: AccountPoolId.make(defaultPoolId) } : {}),
});

const project = ProjectId.make("project-1");
const snapshot = (sections: ReturnType<typeof section>[], sectionId: string | null) =>
  ({
    revision: 1,
    sections,
    projectPlacements: [
      { projectId: project, sectionId: sectionId as SectionId | null, position: 0 },
    ],
  }) satisfies SectionsSnapshot;

const sonnet: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude_hub"),
  model: "claude-sonnet-5-5",
  options: [{ id: "effort", value: "high" }],
};

const settings = (projectOverride?: ModelSelection) => ({
  ...DEFAULT_SERVER_SETTINGS,
  defaultModelSelection: sonnet,
  providerInstances: {
    claude_hub: hub("claudeAgent"),
    codex_hub: hub("codex"),
    claude_hub_work: hub("claudeAgent", "work"),
    codex_hub_lab: hub("codex", "lab"),
  },
  projectSettingsOverrides: projectOverride
    ? { [project]: { defaultModelSelection: projectOverride } }
    : {},
});

const resolve = (input: {
  readonly sections: ReturnType<typeof section>[];
  readonly sectionId: string | null;
  readonly projectOverride?: ModelSelection;
}) =>
  projectDefaultModelSelectionWithSectionPool({
    resolved: resolveProjectSettings(settings(input.projectOverride), project),
    snapshot: snapshot(input.sections, input.sectionId),
    projectId: project,
    providers,
  });

describe("section pool defaults", () => {
  it("takes the nearest section that names a pool", () => {
    const sections = [
      section("work", null, "work"),
      section("team", "work"),
      section("loose", null),
    ];
    expect(sectionDefaultPoolId(snapshot(sections, "team"), project)).toBe("work");
    expect(sectionDefaultPoolId(snapshot(sections, "loose"), project)).toBeNull();
    expect(sectionDefaultPoolId(snapshot(sections, null), project)).toBeNull();
  });

  it("moves the environment default onto the section's pool, keeping model and options", () => {
    expect(resolve({ sections: [section("work", null, "work")], sectionId: "work" })).toEqual({
      ...sonnet,
      instanceId: "claude_hub_work",
    });
  });

  it("falls back to the pool's own provider when it lacks the default's kind", () => {
    expect(resolve({ sections: [section("lab", null, "lab")], sectionId: "lab" })).toEqual({
      instanceId: "codex_hub_lab",
      model: "gpt-6-astra",
    });
  });

  it("leaves a project's own default model alone", () => {
    const own: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex_hub"),
      model: "gpt-6-astra",
    };
    expect(
      resolve({
        sections: [section("work", null, "work")],
        sectionId: "work",
        projectOverride: own,
      }),
    ).toEqual(own);
  });

  it("keeps the default when the section has no pool or its pool has no providers", () => {
    expect(resolve({ sections: [section("plain", null)], sectionId: "plain" })).toEqual(sonnet);
    expect(resolve({ sections: [section("gone", null, "gone")], sectionId: "gone" })).toEqual(
      sonnet,
    );
  });
});
