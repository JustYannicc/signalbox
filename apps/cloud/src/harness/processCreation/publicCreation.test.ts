import { afterEach, expect, it, vi } from "vite-plus/test";
import { HarnessProcessExecutionShardObject } from "../HarnessProcessExecutionShardObject.ts";
import type { HarnessProcessExecutionEnvironment } from "../HarnessProcessPlacement.ts";
import type { HarnessProcessCreationInput } from "../HarnessProcessCreation.ts";
import { loadHarnessRelease } from "../HarnessReleaseLoader.ts";
import { productLoadedPreparedRelease } from "../ProductHarnessProcessRelease.ts";
import { claudeFixture, codexFixture } from "../releaseLoader/tests/artifactFixtures.ts";
import { durableRootContext } from "../tests/processIncarnation/durableRootFixture.ts";
import {
  deploy3QualifierEnvironment,
  materializeDeploy3QualifierEnvironment,
} from "../../../infra/deploy3/qualifierEnvironment.ts";
import { assertQualifierRuntimeConfiguration } from "../../../infra/deploy3/qualification/environmentContract.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const roots: ReturnType<typeof durableRootContext>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.close();
});

async function creation(provider: "codex" | "claude-code") {
  const root = durableRootContext("creation-shard");
  roots.push(root);
  const releaseFixture = await (provider === "codex" ? codexFixture() : claudeFixture());
  const loaded = await loadHarnessRelease(releaseFixture.options);
  const release = productLoadedPreparedRelease(
    provider,
    {
      provider,
      releaseId: `controlled-${provider}`,
      ...releaseFixture.options.identity,
      fixtureIdentity: `controlled-${provider}`,
      createdAt: "2026-10-31T00:00:00.000Z",
    },
    loaded,
  );
  const seed = { id: "creation-seed", bytes: 1, sha256: "a".repeat(64) };
  const input: HarnessProcessCreationInput = {
    runId: "creation-run",
    operationId: "creation-operation",
    run: {
      type: "initialize",
      seed: {
        identity: {
          runId: "creation-run",
          hostId: "creation-host",
          threadId: "creation-thread",
          logicalTurnId: "creation-turn",
          filesystemId: "creation-files",
        },
        locator: seed,
        config: seed,
        artifacts: [seed],
      },
      controlKey: "run-control-".repeat(4),
      supervisorKey: "run-supervisor-".repeat(4),
      claimId: "creation-claim",
      requestId: "creation-initialize",
    },
    controllerClaim: {
      ownerId: "controller",
      incarnationId: "controller-incarnation",
      epoch: 1,
      controlKey: "controller-control-".repeat(3),
    },
    publisherKey: "initial-publisher-".repeat(3),
    requestPublisherKey: "request-publisher-".repeat(3),
    requestModeId: "creation-request-mode",
    facet: {
      processId: "creation-process",
      codeId: release.artifact.releaseId,
      residentBytes: 1,
      mainModule: "creation.mjs",
      modules: { "creation.mjs": { js: "export class CreationFacet {}" } },
      entrypoint: "CreationFacet",
      productBootstrap: {
        provider,
        preparedReleaseId: release.artifact.releaseId,
        restoreMode: "same-variant-serialized-checkpoint",
      },
      targetPreparedRelease: release,
    },
  };
  const initialized: unknown[] = [];
  const beforePlacement = new Error("Stop after public creation reaches durable initialization.");
  const store = {
    async claimProcessFence() {},
    async execute(command: unknown) {
      initialized.push(command);
      throw beforePlacement;
    },
  };
  const namespace = { get: () => store, getByName: () => store, idFromName: () => "creation-run" };
  const load = vi.fn(() => {
    throw new Error("The admission test must not open a facet.");
  });
  const bindings = materializeDeploy3QualifierEnvironment(
    deploy3QualifierEnvironment({
      RUN_ID: "12345678-1234-4234-8234-123456789abc",
      WORKER_NAME: "sb1070-d3-12345678-1793550614-workload",
      CONFIG_SHA256: "a".repeat(64),
      BUNDLE_SHA256: "b".repeat(64),
    }),
    { namespace: () => namespace, loader: () => ({ get: load, load }) },
  );
  const environment = {
    ...bindings.env,
    ...Object.fromEntries(
      bindings.services.map(({ name }) => [
        name,
        { fetch: load, run: load, tail: load, captureOuter: load },
      ]),
    ),
  };
  assertQualifierRuntimeConfiguration(environment);
  const shard = new HarnessProcessExecutionShardObject(
    root.context as unknown as DurableObjectState,
    environment as unknown as HarnessProcessExecutionEnvironment,
  );
  return { input, shard, initialized, beforePlacement, load, environment };
}

it.each(["codex", "claude-code"] as const)(
  "admits a matching %s release with the normal deploy3 environment through public C",
  async (provider) => {
    const fixture = await creation(provider);
    expect(fixture.environment.RESIDENT_BYTE_LIMIT).toBe(String(104 * 1024 * 1024));
    await expect(fixture.shard.startFreshProcess(fixture.input)).rejects.toBe(
      fixture.beforePlacement,
    );
    expect(fixture.initialized).toEqual([fixture.input.run]);
    expect(fixture.load).not.toHaveBeenCalled();
  },
);

it("rejects the deployed missing-budget regression before durable initialization", async () => {
  const fixture = await creation("claude-code");
  delete fixture.environment.RESIDENT_BYTE_LIMIT;
  await expect(fixture.shard.startFreshProcess(fixture.input)).rejects.toThrow(
    "Cold creation requires the public durable stores, loader, placement, and residency limit",
  );
  expect(fixture.initialized).toEqual([]);
  expect(fixture.load).not.toHaveBeenCalled();
});

it.each(["codex", "claude-code"] as const)(
  "rejects another provider's release before initializing a %s run",
  async (provider) => {
    const fixture = await creation(provider);
    const input: HarnessProcessCreationInput = {
      ...fixture.input,
      facet: {
        ...fixture.input.facet,
        productBootstrap: {
          ...fixture.input.facet.productBootstrap,
          provider: provider === "codex" ? "claude-code" : "codex",
        },
      },
    };
    await expect(fixture.shard.startFreshProcess(input)).rejects.toThrow(
      "matching product release",
    );
    expect(fixture.initialized).toEqual([]);
    expect(fixture.load).not.toHaveBeenCalled();
  },
);

it.each(["codex", "claude-code"] as const)(
  "rejects another release ID before initializing a %s run",
  async (provider) => {
    const fixture = await creation(provider);
    const input: HarnessProcessCreationInput = {
      ...fixture.input,
      facet: {
        ...fixture.input.facet,
        productBootstrap: {
          ...fixture.input.facet.productBootstrap,
          preparedReleaseId: "another-release",
        },
      },
    };
    await expect(fixture.shard.startFreshProcess(input)).rejects.toThrow(
      "matching product release",
    );
    expect(fixture.initialized).toEqual([]);
    expect(fixture.load).not.toHaveBeenCalled();
  },
);

it.each(["codex", "claude-code"] as const)(
  "rejects another provider's prepared graph before initializing a %s run",
  async (provider) => {
    const fixture = await creation(provider);
    const selected = fixture.input.facet.targetPreparedRelease;
    const input: HarnessProcessCreationInput = {
      ...fixture.input,
      facet: {
        ...fixture.input.facet,
        targetPreparedRelease: {
          ...selected,
          plan: {
            ...selected.plan,
            release: {
              ...selected.plan.release,
              harness: provider === "codex" ? "claude-code" : "codex",
            },
          },
        },
      },
    };
    await expect(fixture.shard.startFreshProcess(input)).rejects.toThrow(
      "matching product release",
    );
    expect(fixture.initialized).toEqual([]);
    expect(fixture.load).not.toHaveBeenCalled();
  },
);
