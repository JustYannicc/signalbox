import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveNewTaskInitialModelSelection,
  resolveNewTaskSelectedModelSelection,
} from "./new-task-model-selection-policy";

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
}): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    availability: input.availability ?? "available",
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: {},
      ...("pricing" in model ? { pricing: model.pricing } : {}),
      ...("defaultSelection" in model ? { defaultSelection: model.defaultSelection } : {}),
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

function serverConfig(providerList: ReadonlyArray<ServerProvider>): ServerConfig {
  return { settings: DEFAULT_SERVER_SETTINGS, providers: providerList } as ServerConfig;
}

describe("mobile new-task model selection policy", () => {
  it("uses the folder choice, then the person choice, then eligible catalog metadata", () => {
    const folder = { instanceId, model: "folder" };
    const person = { instanceId, model: "person" };
    const base = {
      projectDefaultIsConfigured: true,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectId: null,
      config: serverConfig(providers),
    } as const;

    expect(
      resolveNewTaskInitialModelSelection({
        ...base,
        projectDefaultSelection: folder,
        personDefaultSelection: person,
      }),
    ).toBe(folder);
    expect(
      resolveNewTaskInitialModelSelection({
        ...base,
        projectDefaultIsConfigured: false,
        projectDefaultSelection: folder,
        personDefaultSelection: person,
      }),
    ).toBe(person);
    expect(
      resolveNewTaskInitialModelSelection({
        ...base,
        projectDefaultIsConfigured: false,
        projectDefaultSelection: null,
        personDefaultSelection: null,
      }),
    ).toEqual({ instanceId, model: "economy" });
  });

  it("leaves an explicit draft selection ahead of the pool and configured defaults", () => {
    const draftSelection = { instanceId, model: "chosen" };
    const poolSelection = {
      instanceId: ProviderInstanceId.make("pool-codex"),
      model: "pool",
    };

    expect(
      resolveNewTaskSelectedModelSelection({
        draftSelection,
        initialSelection: { instanceId, model: "economy" },
        poolSelection,
      }),
    ).toEqual({
      projectDefaultModelSelection: poolSelection,
      selectedModelSelection: draftSelection,
    });
  });

  it("uses a compatible pool choice and falls back when the pool cannot run it", () => {
    const initialSelection = { instanceId, model: "economy" };
    const poolSelection = {
      instanceId: ProviderInstanceId.make("pool-codex"),
      model: "pool",
    };

    expect(
      resolveNewTaskSelectedModelSelection({
        draftSelection: null,
        initialSelection,
        poolSelection,
      }),
    ).toEqual({
      projectDefaultModelSelection: poolSelection,
      selectedModelSelection: poolSelection,
    });
    expect(
      resolveNewTaskSelectedModelSelection({
        draftSelection: null,
        initialSelection,
        poolSelection: null,
      }),
    ).toEqual({
      projectDefaultModelSelection: initialSelection,
      selectedModelSelection: initialSelection,
    });
  });

  it("skips unavailable providers when choosing metadata defaults", () => {
    const unavailable = provider({
      availability: "unavailable",
      models: [
        {
          slug: "cheapest",
          pricing: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
        },
      ],
    });
    const resolved = resolveNewTaskInitialModelSelection({
      projectDefaultIsConfigured: false,
      projectDefaultSelection: null,
      personDefaultSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
      projectId: null,
      config: serverConfig([unavailable, ...providers]),
    });

    expect(resolved).toEqual({ instanceId, model: "economy" });
  });
});
