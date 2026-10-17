import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ResolvedPool, SectionsSnapshot } from "@t3tools/contracts/sections";
import { describe, expect, it } from "vite-plus/test";

import { poolNeed, projectPool, projectPoolModelSelection } from "./projectPool.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
  authenticated = true,
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    auth: { status: authenticated ? "authenticated" : "unauthenticated" },
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
  provider("codex_hub", "codex", ["gpt-6-astra", "gpt-6-luna"]),
  provider("claude_hub_work", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5-5"]),
  provider("codex_hub_lab", "codex", ["gpt-6-astra", "gpt-6-luna"]),
  provider("claude_hub_empty", "claudeAgent", [], false),
];

const hub = (poolId?: string) => ({ config: { setupMode: "hub", ...(poolId ? { poolId } : {}) } });
const providerInstances = {
  claude_hub: hub(),
  codex_hub: hub(),
  claude_hub_work: hub("work"),
  codex_hub_lab: hub("lab"),
  claude_hub_empty: hub("empty"),
};

const project = ProjectId.make("project-1");
const personal: ResolvedPool = { poolId: "personal", from: { _tag: "top" } };
const onPool = (poolId: string): ResolvedPool => ({
  poolId,
  from: { _tag: "section", sectionId: "s" },
});
const snapshot = (pool: ResolvedPool | null, sent = true): SectionsSnapshot => ({
  revision: 1,
  sections: [],
  projectPlacements: [],
  ...(sent
    ? { pools: { top: personal, sections: [], projects: [{ projectId: project, pool }] } }
    : {}),
});

const sonnet: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude_hub"),
  model: "claude-sonnet-5-5",
  options: [{ id: "effort", value: "high" }],
};
const onItsPool = (pool: ResolvedPool | null, selection: ModelSelection | null = sonnet) =>
  projectPoolModelSelection({
    selection,
    snapshot: snapshot(pool),
    projectId: project,
    providerInstances,
    providers,
  });

describe("project pools", () => {
  it("reads the pool the server resolved, the top level's for anything unlisted", () => {
    expect(projectPool(snapshot(onPool("work")), project)?.poolId).toBe("work");
    expect(projectPool(snapshot(null), project)).toBeNull();
    expect(projectPool(snapshot(null), ProjectId.make("other"))).toEqual(personal);
    expect(projectPool(snapshot(null), null)).toEqual(personal);
    // A server that doesn't resolve pools leaves it open.
    expect(projectPool(snapshot(null, false), project)).toBeUndefined();
  });

  it("moves a new thread's model onto its pool, keeping model and options", () => {
    expect(onItsPool(onPool("work"))).toEqual({ ...sonnet, instanceId: "claude_hub_work" });
    // A different provider still uses an economical fallback.
    expect(onItsPool(onPool("lab"))).toEqual({ instanceId: "codex_hub_lab", model: "gpt-6-luna" });
    expect(onItsPool(onPool("work"), null)).toEqual({
      instanceId: "claude_hub_work",
      model: "claude-sonnet-5-5",
    });
    expect(onItsPool(null)).toBeNull();
    expect(onItsPool(onPool("empty"))).toBeNull();
  });

  it("does not select a flagship when a pool has no economical model", () => {
    expect(
      projectPoolModelSelection({
        selection: null,
        snapshot: snapshot(onPool("work")),
        projectId: project,
        providerInstances,
        providers: [
          provider("claude_hub_work", "claudeAgent", ["claude-fable-5-1", "claude-opus-5-5"]),
        ],
      }),
    ).toBeNull();
  });

  it("needs a pool with none on the chain, or one nobody is signed in to", () => {
    const need = (pool: ResolvedPool | null | undefined) =>
      poolNeed({ pool, providerInstances, providers });
    expect(need(undefined)).toBeNull();
    expect(need(onPool("work"))).toBeNull();
    expect(need(null)).toEqual({ _tag: "noPool" });
    expect(need(onPool("empty"))).toEqual({
      _tag: "signIn",
      poolId: "empty",
      instanceId: "claude_hub_empty",
    });
  });

  it("keeps an unreadable pool distinct from sign-in and a signed-in pool with no models", () => {
    const downId = ProviderInstanceId.make("claude_hub_down");
    const emptyId = ProviderInstanceId.make("codex_hub_no_models");
    const unavailable = {
      ...provider(downId, "claudeAgent", [], false),
      status: "error",
      auth: { status: "unknown" },
      availability: "available",
      message: "The pool is unavailable right now. Try again.",
    } as unknown as ServerProvider;
    const noModels = {
      ...provider(emptyId, "codex", [], true),
      status: "warning",
      message: "This pool's accounts serve no models right now. Try again shortly.",
    } as unknown as ServerProvider;
    const instances = {
      ...providerInstances,
      [downId]: hub("down"),
      [emptyId]: hub("no-models"),
    };

    expect(
      poolNeed({ pool: onPool("down"), providerInstances: instances, providers: [unavailable] }),
    ).toEqual({
      _tag: "unavailable",
      poolId: "down",
      message: "The pool is unavailable right now. Try again.",
    });
    expect(
      poolNeed({ pool: onPool("no-models"), providerInstances: instances, providers: [noModels] }),
    ).toEqual({
      _tag: "noModels",
      poolId: "no-models",
      message: "This pool's accounts serve no models right now. Try again shortly.",
    });
  });
});
