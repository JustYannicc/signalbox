import { describe, expect, it } from "vite-plus/test";

import { agentAccess } from "../levels/levelAccess";
import { TOP_LEVEL } from "../levels/levels";
import { CLIENT_DEVICES } from "./devicesFixtures";
import { deviceGateways } from "./devicesModel";

const placement = { projectSectionOverrides: { "env:dotfiles": "personal" } };
const gateways = deviceGateways(CLIENT_DEVICES);
const names = (things: readonly { id: string }[]) => things.map((thing) => thing.id);

describe("deviceGateways", () => {
  it("places only enabled, available gateways at their device's level", () => {
    const sms = gateways.find((gateway) => gateway.id === "pixel:sms");
    expect(sms).toMatchObject({ levels: ["section:personal"], reach: "below" });
    expect(names(gateways)).not.toContain("macbook:nfc");
    expect(names(gateways)).not.toContain("macbook:clipboard");
  });

  it("lets folders inside use a device that reaches below, and nothing else", () => {
    const access = agentAccess("project:env:dotfiles", gateways, placement);
    expect(names(access.usable)).toContain("pixel:sms");
    expect(names(access.usable)).not.toContain("macbook:screenshot");
  });

  it("makes Work ask the top level for your Personal phone", () => {
    const work = agentAccess("section:work", gateways, placement);
    expect(names(work.usable)).toContain("work-laptop:screenshot");
    expect(names(work.usable)).not.toContain("pixel:sms");
    const askFor = (id: string) =>
      agentAccess("team-project:terminal-app", gateways, placement).asks.find((entry) =>
        names(entry.things).includes(id),
      )?.level;
    expect(askFor("pixel:sms")).toBe(TOP_LEVEL);
    expect(askFor("work-laptop:screenshot")).toBe("section:work");
  });
});
