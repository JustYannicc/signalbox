import { describe, expect, it } from "vite-plus/test";

import { browserLauncher } from "./browserLauncher";

const cloudWeb = {
  desktop: false,
  serverBrowser: false,
  agentBrowser: true,
  canOperatePreview: false,
  canReadAgentBrowser: true,
};

describe("browserLauncher", () => {
  it("lets a cloud web reader open the agent mirror without local profiles", () => {
    expect(browserLauncher(cloudWeb)).toEqual({
      target: "agent-browser",
      available: true,
      profilesAvailable: false,
      permitted: true,
    });
  });

  it("keeps desktop browser tabs and their operate permission on cloud", () => {
    const desktop = { ...cloudWeb, desktop: true };
    expect(browserLauncher(desktop)).toEqual({
      target: "preview",
      available: true,
      profilesAvailable: true,
      permitted: false,
    });
    expect(browserLauncher({ ...desktop, canOperatePreview: true }).permitted).toBe(true);
  });

  it("uses a real server browser when one is available", () => {
    expect(browserLauncher({ ...cloudWeb, serverBrowser: true, canOperatePreview: true })).toEqual({
      target: "preview",
      available: true,
      profilesAvailable: true,
      permitted: true,
    });
  });

  it("has no launcher without a browser engine or agent mirror", () => {
    expect(browserLauncher({ ...cloudWeb, agentBrowser: false }).available).toBe(false);
  });

  it("requires read access to open the agent mirror", () => {
    expect(browserLauncher({ ...cloudWeb, canReadAgentBrowser: false }).permitted).toBe(false);
  });
});
