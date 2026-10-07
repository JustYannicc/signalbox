import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  // signalbox: Cursor keys go into a pool, so the provider offers no key field of its own.
  it("offers no Cursor key or legacy CLI setting", () => {
    const cursor = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("cursor")];

    expect(cursor).toBeDefined();
    expect(deriveProviderSettingsFields(cursor!)).toEqual([]);
    expect(cursor?.environmentFields).toEqual([]);
  });

  it("exposes ACP Registry as an instance-only configurable driver", () => {
    const acpRegistry = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpRegistry")];

    expect(acpRegistry).toBeDefined();
    expect(acpRegistry?.hasDefaultInstance).toBe(false);
    expect(deriveProviderSettingsFields(acpRegistry!).map((field) => field.key)).toEqual([
      "source",
      "agentId",
      "commandPath",
      "authMethodId",
    ]);
  });

  it("shows the local executable without registry identity or authentication fields", () => {
    const acpRegistry = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpRegistry")];
    expect(
      deriveProviderSettingsFields(acpRegistry!, { source: "local" }).map((field) => field.key),
    ).toEqual(["source", "commandPath"]);
  });

  // signalbox: Antigravity accounts and Gemini keys go into a pool, not the provider's settings.
  it("hides the Antigravity sign-in method and API key", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("antigravity")];
    expect(antigravity).toBeDefined();

    expect(deriveProviderSettingsFields(antigravity!).map((field) => field.key)).toEqual([
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "launchArgs",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});
