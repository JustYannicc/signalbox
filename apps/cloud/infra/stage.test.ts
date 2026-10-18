// @effect-diagnostics nodeBuiltinImport:off - reads wrangler.jsonc from disk.
import * as NodeFS from "node:fs";

import { ThreadId } from "@t3tools/contracts";
import { MODEL_GATEWAY_PATHS } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";

import { previewLabel } from "@t3tools/shared/preview";
import { previewOrigin, previewSettings } from "../src/thread/preview/previewHost.ts";

import { parseJsonc } from "../../../scripts/cloud-migrations/check.ts";
import {
  AUTOMATION_BINDINGS,
  COMPATIBILITY_DATE,
  cloudStage,
  DURABLE_OBJECT_BINDINGS,
  previewStageNumber,
  stageWorkerRouting,
} from "./stage.ts";
import { TRACES_PATH } from "../src/observability/nativeTracesWorker.ts";

interface WranglerConfig {
  readonly compatibility_date: string;
  readonly durable_objects: {
    readonly bindings: ReadonlyArray<{ name: string; class_name: string }>;
  };
  readonly containers: ReadonlyArray<{ class_name: string; max_instances: number }>;
  readonly workflows: ReadonlyArray<{ binding: string; name: string; class_name: string }>;
  readonly worker_loaders: ReadonlyArray<{ binding: string }>;
  readonly migrations: ReadonlyArray<{ tag: string; new_sqlite_classes?: ReadonlyArray<string> }>;
  readonly vars: Readonly<Record<string, string>>;
  readonly env: {
    readonly dev: Pick<WranglerConfig, "durable_objects" | "workflows" | "worker_loaders">;
  };
}

const readWrangler = (file: string) =>
  parseJsonc(NodeFS.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const wrangler = readWrangler("wrangler.jsonc") as WranglerConfig;

describe("cloudStage", () => {
  it("keeps production's wrangler-made names", () => {
    const production = cloudStage("production");
    expect(production).toMatchObject({
      production: true,
      cloudWorker: "signalbox-cloud",
      gatewayWorker: "signalbox-model-gateway",
      cloudDomain: "app.signalbox.run",
      gatewayDomain: "gateway.signalbox.run",
      previewHost: "*-app.signalbox-preview.dev",
      poolContainer: { name: "signalbox-cloud-poolobject" },
      threadContainer: { name: "signalbox-cloud-threadobject" },
      drivePacksBucket: "signalbox-drives",
      automationWorkflow: "signalbox-cloud-automations",
      vars: {
        SIGNALBOX_STAGE: "production",
        ENVIRONMENT_ID: "4bfb70e5-7954-458a-9b75-4834c0ab4e13",
        EXECUTOR_TOKEN_ISSUER: "https://app.signalbox.run",
        CLOUD_URL: "https://app.signalbox.run",
        MODEL_GATEWAY_URL: "https://gateway.signalbox.run",
        PREVIEW_DOMAIN: "*-app.signalbox-preview.dev",
      },
    });
  });

  it("gives a pull request its own preview", () => {
    expect(cloudStage("pr-298")).toMatchObject({
      production: false,
      cloudWorker: "signalbox-cloud-pr-298",
      gatewayWorker: "signalbox-model-gateway-pr-298",
      cloudDomain: "preview-298.signalbox.run",
      gatewayDomain: "gateway-preview-298.signalbox.run",
      previewHost: "*-pr298.signalbox-preview.dev",
      poolContainer: { name: "signalbox-cloud-pr-298-pools" },
      threadContainer: { name: "signalbox-cloud-pr-298-threads" },
      drivePacksBucket: "signalbox-drives-preview",
      automationWorkflow: "signalbox-cloud-pr-298-automations",
      vars: {
        SIGNALBOX_STAGE: "pr-298",
        ENVIRONMENT_ID: "cloud-preview-298",
        EXECUTOR_TOKEN_ISSUER: "https://preview-298.signalbox.run",
        DRIVE_PACKS_PREFIX: "pr-298/",
        MODEL_GATEWAY_URL: "https://preview-298.signalbox.run",
        PREVIEW_DOMAIN: "*-pr298.signalbox-preview.dev",
        PREVIEW_SETUP_SOURCE: "https://app.signalbox.run",
      },
    });
  });

  it("routes preview gateway and trace paths through the app origin", () => {
    const preview = cloudStage("pr-298");
    const gateway = stageWorkerRouting(preview, preview.gatewayDomain, [
      MODEL_GATEWAY_PATHS.anthropic,
      MODEL_GATEWAY_PATHS.openai,
    ]);
    const traces = stageWorkerRouting(preview, `traces-${preview.cloudDomain}`, [TRACES_PATH]);
    expect(gateway).toEqual({
      domain: null,
      routes: [
        {
          pattern: `${preview.cloudDomain}${MODEL_GATEWAY_PATHS.anthropic}*`,
          zoneId: "e817cf0e17e849a0aab7a0bf92c0a053",
        },
        {
          pattern: `${preview.cloudDomain}${MODEL_GATEWAY_PATHS.openai}*`,
          zoneId: "e817cf0e17e849a0aab7a0bf92c0a053",
        },
      ],
    });
    expect(traces).toEqual({
      domain: null,
      routes: [
        {
          pattern: `${preview.cloudDomain}${TRACES_PATH}*`,
          zoneId: "e817cf0e17e849a0aab7a0bf92c0a053",
        },
      ],
    });
    expect(
      [MODEL_GATEWAY_PATHS.anthropic, MODEL_GATEWAY_PATHS.openai].map(
        (path) => new URL(path, preview.vars.MODEL_GATEWAY_URL).origin,
      ),
    ).toEqual([`https://${preview.cloudDomain}`, `https://${preview.cloudDomain}`]);
  });

  it("keeps production Worker domains and omits preview route props", () => {
    const production = cloudStage("production");
    const gateway = stageWorkerRouting(production, production.gatewayDomain, [
      MODEL_GATEWAY_PATHS.anthropic,
      MODEL_GATEWAY_PATHS.openai,
    ]);
    const traces = stageWorkerRouting(production, `traces-${production.cloudDomain}`, [
      TRACES_PATH,
    ]);
    expect(gateway).toEqual({
      domain: { name: "gateway.signalbox.run", zoneId: "e817cf0e17e849a0aab7a0bf92c0a053" },
    });
    expect(traces).toEqual({
      domain: { name: "traces-app.signalbox.run", zoneId: "e817cf0e17e849a0aab7a0bf92c0a053" },
    });
    expect("routes" in gateway).toBe(false);
    expect("routes" in traces).toBe(false);
  });

  it("routes each stage's dev-server previews to it alone", async () => {
    const label = await previewLabel(ThreadId.make("thread:1"), 5173);
    const hosts = (stage: string) => cloudStage(stage).previewHost;
    // A route pattern's leading `*` matches any characters (Cloudflare's own syntax).
    const matches = (pattern: string, host: string) => host.endsWith(pattern.slice(1));
    for (const stage of ["production", "pr-29", "pr-299", "pr-2990"]) {
      const host = previewOrigin(
        previewSettings({ PREVIEW_DOMAIN: cloudStage(stage).previewHost })!,
        label,
      ).slice("https://".length);
      for (const other of ["production", "pr-29", "pr-299", "pr-2990"]) {
        expect(matches(hosts(other), host)).toBe(other === stage);
      }
      // One level under the zone, so Universal SSL's wildcard covers it.
      expect(host.split(".")).toHaveLength(3);
    }
  });

  it("refuses any other stage, so nothing else can claim a name", () => {
    for (const stage of ["prod", "live_yannic", "pr-0", "pr-01", "pr-12a", "Production"]) {
      expect(() => cloudStage(stage)).toThrow(/Unknown Signalbox Cloud stage/);
      expect(previewStageNumber(stage)).toBeNull();
    }
  });
});

// `wrangler dev` runs wrangler.jsonc; deploys run the stack. They must agree.
describe("wrangler.jsonc", () => {
  it("runs the deployed Durable Objects and containers", () => {
    expect(
      Object.fromEntries(
        wrangler.durable_objects.bindings.map((binding) => [binding.name, binding.class_name]),
      ),
    ).toEqual(DURABLE_OBJECT_BINDINGS);
    expect(
      Object.fromEntries(
        wrangler.env.dev.durable_objects.bindings.map((binding) => [
          binding.name,
          binding.class_name,
        ]),
      ),
    ).toEqual(DURABLE_OBJECT_BINDINGS);
    expect(wrangler.containers.map((container) => container.class_name).sort()).toEqual([
      DURABLE_OBJECT_BINDINGS.POOLS,
      DURABLE_OBJECT_BINDINGS.THREADS,
    ]);
    const production = cloudStage("production");
    expect(
      Object.fromEntries(
        wrangler.containers.map((container) => [container.class_name, container.max_instances]),
      ),
    ).toEqual({
      [DURABLE_OBJECT_BINDINGS.POOLS]: production.poolContainer.maxInstances,
      [DURABLE_OBJECT_BINDINGS.THREADS]: production.threadContainer.maxInstances,
    });
  });

  it("runs the automation Workflow and loader, in dev too", () => {
    for (const config of [wrangler, wrangler.env.dev]) {
      expect(config.workflows).toEqual([
        {
          binding: AUTOMATION_BINDINGS.workflow,
          name: cloudStage("production").automationWorkflow,
          class_name: AUTOMATION_BINDINGS.workflowClass,
        },
      ]);
      expect(config.worker_loaders).toEqual([{ binding: AUTOMATION_BINDINGS.loader }]);
    }
  });

  it("runs production's compatibility date and identity", () => {
    expect(wrangler.compatibility_date).toBe(COMPATIBILITY_DATE);
    expect(
      (readWrangler("wrangler.model-gateway.jsonc") as WranglerConfig).compatibility_date,
    ).toBe(COMPATIBILITY_DATE);
    expect(wrangler.vars.ENVIRONMENT_ID).toBe(cloudStage("production").vars.ENVIRONMENT_ID);
    expect(wrangler.vars.EXECUTOR_TOKEN_ISSUER).toBe("http://localhost");
  });

  it("retains the token binding before the additive search migration", () => {
    expect(wrangler.migrations.slice(-2)).toEqual([
      {
        tag: "v6",
        new_sqlite_classes: [DURABLE_OBJECT_BINDINGS.EXECUTOR_TOKEN_BINDINGS],
      },
      {
        tag: "search-index-v1",
        new_sqlite_classes: [DURABLE_OBJECT_BINDINGS.SEARCH_INDEX],
      },
    ]);
  });
});
