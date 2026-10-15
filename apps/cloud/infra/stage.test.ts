// @effect-diagnostics nodeBuiltinImport:off - reads wrangler.jsonc from disk.
import * as NodeFS from "node:fs";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { previewLabel, previewOrigin, previewSettings } from "../src/thread/preview/previewHost.ts";

import { parseJsonc } from "../../../scripts/cloud-migrations/check.ts";
import {
  COMPATIBILITY_DATE,
  cloudStage,
  DURABLE_OBJECT_BINDINGS,
  previewStageNumber,
} from "./stage.ts";

interface WranglerConfig {
  readonly compatibility_date: string;
  readonly durable_objects: {
    readonly bindings: ReadonlyArray<{ name: string; class_name: string }>;
  };
  readonly containers: ReadonlyArray<{ class_name: string }>;
  readonly vars: Readonly<Record<string, string>>;
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
      vars: {
        ENVIRONMENT_ID: "4bfb70e5-7954-458a-9b75-4834c0ab4e13",
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
      vars: {
        ENVIRONMENT_ID: "cloud-preview-298",
        DRIVE_PACKS_PREFIX: "pr-298/",
        MODEL_GATEWAY_URL: "https://gateway-preview-298.signalbox.run",
        PREVIEW_DOMAIN: "*-pr298.signalbox-preview.dev",
        PREVIEW_SETUP_SOURCE: "https://app.signalbox.run",
      },
    });
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
    expect(wrangler.containers.map((container) => container.class_name).sort()).toEqual([
      DURABLE_OBJECT_BINDINGS.POOLS,
      DURABLE_OBJECT_BINDINGS.THREADS,
    ]);
  });

  it("runs production's compatibility date and identity", () => {
    expect(wrangler.compatibility_date).toBe(COMPATIBILITY_DATE);
    expect(
      (readWrangler("wrangler.model-gateway.jsonc") as WranglerConfig).compatibility_date,
    ).toBe(COMPATIBILITY_DATE);
    expect(wrangler.vars.ENVIRONMENT_ID).toBe(cloudStage("production").vars.ENVIRONMENT_ID);
  });
});
