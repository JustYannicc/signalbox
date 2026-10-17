import { describe, expect, it } from "vite-plus/test";

import { keybindingSearchAnchorId, filterAvailableSettingsSearchItems } from "./settingsSearch";

const availability = {
  hasCloudPublicConfig: false,
  hasEnvironment: true,
  hasProviderSettingsEnvironment: true,
  hasMacProviderSettingsEnvironment: false,
  canManageLocalBackend: false,
  isWslSettingsRowVisible: false,
  hasThreadAutoSettlement: false,
};

const searchIds = (unsupported: ReadonlyArray<"terminal" | "worktrees" | "localFilesystem">) =>
  filterAvailableSettingsSearchItems({
    ...availability,
    unsupportedCapabilities: new Set(unsupported),
  }).map((item) => item.id);

describe("keybinding search results on an environment without a terminal, worktrees or editors", () => {
  it("drops commands that can't run there", () => {
    const ids = searchIds(["terminal", "worktrees", "localFilesystem"]);
    expect(ids).not.toContain(keybindingSearchAnchorId("terminal.toggle"));
    expect(ids).not.toContain(keybindingSearchAnchorId("composer.previousWorktree"));
    expect(ids).not.toContain(keybindingSearchAnchorId("composer.branch"));
    expect(ids).not.toContain(keybindingSearchAnchorId("editor.openFavorite"));
    expect(ids).not.toContain("terminal-font");
    expect(ids).toContain(keybindingSearchAnchorId("commandPalette.toggle"));
  });

  it("keeps them where an environment can run them", () => {
    const ids = searchIds([]);
    expect(ids).toContain(keybindingSearchAnchorId("terminal.toggle"));
    expect(ids).toContain(keybindingSearchAnchorId("composer.branch"));
    expect(ids).toContain("terminal-font");
  });
});
