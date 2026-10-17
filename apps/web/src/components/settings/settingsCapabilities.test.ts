import { describe, expect, it } from "vite-plus/test";

import {
  filterAvailableSettingsSearchItems,
  isSettingsPathAvailable,
  SETTINGS_SEARCH_ITEMS,
} from "./settingsSearch";
import { settingsItemSupported } from "./settingsCapabilities";

const availability = {
  hasCloudPublicConfig: true,
  hasEnvironment: true,
  hasProviderSettingsEnvironment: true,
  hasMacProviderSettingsEnvironment: true,
  canManageLocalBackend: true,
  isWslSettingsRowVisible: true,
  hasThreadAutoSettlement: true,
};

describe("settings capability requirements", () => {
  it("removes unavailable pages and their search destinations", () => {
    const unsupportedCapabilities = new Set(["localFilesystem"] as const);
    expect(isSettingsPathAvailable("/settings/storage", unsupportedCapabilities)).toBe(false);
    expect(isSettingsPathAvailable("/settings/diagnostics", unsupportedCapabilities)).toBe(false);
    const items = filterAvailableSettingsSearchItems({ ...availability, unsupportedCapabilities });
    expect(items.some((item) => item.to === "/settings/storage")).toBe(false);
    expect(items.some((item) => item.to === "/settings/diagnostics")).toBe(false);
    expect(items.some((item) => item.id === "diagnostics")).toBe(false);
    expect(items.some((item) => item.id === "word-wrap")).toBe(true);
  });

  it("removes server configuration search results without hiding provider models", () => {
    const items = filterAvailableSettingsSearchItems({
      ...availability,
      unsupportedCapabilities: new Set(["serverSettingsWrite"]),
    });
    const ids = items.map((item) => item.id);
    expect(ids).toContain("providers");
    expect(settingsItemSupported("product-analytics", new Set(["serverSettingsWrite"]))).toBe(
      false,
    );
    expect(settingsItemSupported("product-analytics", new Set())).toBe(true);
    for (const id of [
      "usage-providers",
      "cursor-keychain-usage",
      "provider-health-check-interval",
      "github-accounts",
      "source-control-host-gitlab",
      "source-control-host-bitbucket",
      "source-control-host-forgejo",
      "source-control-host-azure-devops",
      "project-actions",
    ]) {
      expect(filterAvailableSettingsSearchItems(availability).map((item) => item.id)).toContain(id);
      expect(ids).not.toContain(id);
    }
  });

  it("hides terminal actions and environment identification only when unsupported", () => {
    const items = filterAvailableSettingsSearchItems({
      ...availability,
      unsupportedCapabilities: new Set(["terminal", "otherEnvironments"]),
    });
    expect(items.some((item) => item.id === "project-actions")).toBe(false);
    expect(items.some((item) => item.id === "environment-identification")).toBe(false);
    const selfHosted = filterAvailableSettingsSearchItems(availability);
    for (const id of [
      "project-actions",
      "environment-identification",
      "storage-delete-now",
      "github-accounts",
    ])
      expect(selfHosted).toContainEqual(SETTINGS_SEARCH_ITEMS.find((item) => item.id === id));
    expect(isSettingsPathAvailable("/settings/storage", new Set())).toBe(true);
  });

  it("searches for the same current-folder action the keybindings page displays", () => {
    const items = filterAvailableSettingsSearchItems({
      ...availability,
      unsupportedCapabilities: new Set(["localFilesystem"]),
    });
    expect(items.find((item) => item.id === "keybinding-chat.newLocal")?.title).toBe(
      "Chat: New in Current Folder",
    );
    expect(
      filterAvailableSettingsSearchItems(availability).find(
        (item) => item.id === "keybinding-chat.newLocal",
      )?.title,
    ).toBe("Chat: New Local");
  });
});
