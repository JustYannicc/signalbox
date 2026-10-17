import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import {
  mapDefaultModelSelectionToPool,
  resolveComposerDefaultModelSelection,
  resolveFreshComposerModelSelection,
} from "./defaultModelSelectionPolicy";

const instanceId = ProviderInstanceId.make("codex");

function provider(input: {
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly pricing?: {
      readonly inputCostPerMillionTokens: number;
      readonly outputCostPerMillionTokens: number;
    };
    readonly defaultSelection?: "excluded" | "configured";
  }>;
  readonly availability?: "available" | "unavailable";
  readonly enabled?: boolean;
  readonly authenticated?: boolean;
}): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: input.authenticated === false ? "unauthenticated" : "authenticated" },
    availability: input.availability ?? "available",
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: {},
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      ...(model.defaultSelection === undefined ? {} : { defaultSelection: model.defaultSelection }),
    })) as ServerProvider["models"],
    slashCommands: [],
    skills: [],
  };
}

const providers = [
  provider({
    models: [
      {
        slug: "folder",
        pricing: { inputCostPerMillionTokens: 100, outputCostPerMillionTokens: 200 },
      },
      {
        slug: "person",
        pricing: { inputCostPerMillionTokens: 100, outputCostPerMillionTokens: 200 },
      },
      {
        slug: "flagship",
        defaultSelection: "excluded",
        pricing: { inputCostPerMillionTokens: 100, outputCostPerMillionTokens: 200 },
      },
      { slug: "economy", pricing: { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } },
    ],
  }),
];

describe("Signalbox composer model selection policy", () => {
  it("keeps an explicit fresh-draft choice ahead of defaults", () => {
    const draftSelection = { instanceId, model: "chosen" };
    const defaults = resolveComposerDefaultModelSelection({
      isNewThreadDraft: true,
      draftModelSelectionExplicit: true,
      projectDefaultSelection: { instanceId, model: "folder" },
      personDefaultSelection: { instanceId, model: "person" },
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectId: null,
      providers,
    });

    expect(defaults.initialModelSelection).toBeNull();
    expect(
      resolveFreshComposerModelSelection({
        isNewThreadDraft: true,
        draftModelSelectionExplicit: true,
        draftSelection,
        initialModelSelection: { instanceId, model: "folder" },
        poolSelection: { instanceId, model: "pool" },
      }),
    ).toBe(draftSelection);
  });

  it("uses the folder choice, then the person choice, then eligible catalog metadata", () => {
    const folder = { instanceId, model: "folder" };
    const person = { instanceId, model: "person" };
    const base = {
      isNewThreadDraft: true,
      draftModelSelectionExplicit: false,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectId: null,
      providers,
    } as const;

    expect(
      resolveComposerDefaultModelSelection({
        ...base,
        projectDefaultSelection: folder,
        personDefaultSelection: person,
      }).initialModelSelection,
    ).toBe(folder);
    expect(
      resolveComposerDefaultModelSelection({
        ...base,
        projectDefaultSelection: null,
        personDefaultSelection: person,
      }).initialModelSelection,
    ).toBe(person);
    expect(
      resolveComposerDefaultModelSelection({
        ...base,
        projectDefaultSelection: null,
        personDefaultSelection: null,
      }).initialModelSelection,
    ).toEqual({ instanceId, model: "economy" });
  });

  it("keeps the original choice when the project has no compatible pool model", () => {
    const initialSelection = { instanceId, model: "economy" };
    const poolSelection = { instanceId: ProviderInstanceId.make("pool-codex"), model: "pool" };

    expect(mapDefaultModelSelectionToPool(initialSelection, () => poolSelection)).toBe(
      poolSelection,
    );
    expect(mapDefaultModelSelectionToPool(initialSelection, () => null)).toBe(initialSelection);
    expect(
      resolveFreshComposerModelSelection({
        isNewThreadDraft: true,
        draftModelSelectionExplicit: false,
        draftSelection: null,
        initialModelSelection: initialSelection,
        poolSelection: null,
      }),
    ).toBe(initialSelection);
  });

  it("does not choose an unavailable provider's cheap catalog model", () => {
    const unavailable = provider({
      availability: "unavailable",
      models: [
        {
          slug: "cheapest",
          pricing: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
        },
      ],
    });
    const resolved = resolveComposerDefaultModelSelection({
      isNewThreadDraft: true,
      draftModelSelectionExplicit: false,
      projectDefaultSelection: null,
      personDefaultSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectId: null,
      providers: [unavailable, ...providers],
    });

    expect(resolved.initialModelSelection).toEqual({ instanceId, model: "economy" });
  });

  it("does not use a person default disabled for the active project", () => {
    const projectId = ProjectId.make("project");
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      projectSettingsOverrides: {
        ...DEFAULT_UNIFIED_SETTINGS.projectSettingsOverrides,
        [projectId]: {
          ...DEFAULT_UNIFIED_SETTINGS.projectSettingsOverrides[projectId],
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    };
    const resolved = resolveComposerDefaultModelSelection({
      isNewThreadDraft: true,
      draftModelSelectionExplicit: false,
      projectDefaultSelection: null,
      personDefaultSelection: { instanceId, model: "person" },
      settings,
      projectId,
      providers,
    });

    expect(resolved.personDefaultSelection).toBeNull();
    expect(resolved.initialModelSelection).toBeNull();
  });
});
