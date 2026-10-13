import { describe, expect, it } from "vite-plus/test";

import type { EscalationRule } from "./escalation";
import { TOP_LEVEL } from "./levels";
import { recentPings, routePing } from "./recentPings";

const PERSONAL = "section:personal";
const SIGNALBOX = "project:env:signalbox";
const placement = { projectSectionOverrides: { "env:signalbox": "personal" } };

const DEVICES = [
  { id: "macbook", name: "MacBook Pro", level: PERSONAL, notify: "badge" as const },
  { id: "pixel", name: "Pixel 8 Pro", level: PERSONAL, notify: "urgent" as const },
  {
    id: "work-laptop",
    name: "Northwind ThinkPad",
    level: "section:work",
    notify: "badge" as const,
  },
];
const RULE: EscalationRule = {
  id: "terminal-app-urgent",
  level: "team-project:terminal-app",
  statuses: ["approval", "failed"],
  deviceIds: ["pixel"],
};
const OVERRIDES = { [PERSONAL]: "none", [SIGNALBOX]: "important" } as const;

const routes = (
  focus: string,
  overrides: Record<string, "all" | "important" | "none"> = OVERRIDES,
) =>
  Object.fromEntries(
    recentPings(SIGNALBOX).map((ping) => {
      const route = routePing(ping, {
        devices: DEVICES,
        focus,
        rules: [RULE],
        overrides,
        fallback: "important",
        placement,
      });
      return [
        ping.id,
        route.kind === "landed"
          ? { devices: route.devices.map((device) => device.id), brokeThrough: route.brokeThrough }
          : route,
      ];
    }),
  );

describe("routePing", () => {
  it("shows the demo story with Focus on Personal", () => {
    expect(routes(PERSONAL)).toEqual({
      "terminal-app-pilot": { devices: ["pixel"], brokeThrough: true },
      "appa-lisbon-seat": { devices: ["macbook", "pixel"], brokeThrough: false },
      "merchant-portal-webhooks": { kind: "hidden" },
      "personal-project-ci": { devices: ["macbook", "pixel"], brokeThrough: false },
      "personal-tax-receipts": { kind: "muted", from: PERSONAL },
    });
  });

  it("routes Work things to the Work laptop when nothing is hidden", () => {
    const all = routes(TOP_LEVEL);
    expect(all["terminal-app-pilot"]).toEqual({
      devices: ["pixel", "work-laptop"],
      brokeThrough: false,
    });
    expect(all["merchant-portal-webhooks"]).toEqual({
      devices: ["work-laptop"],
      brokeThrough: false,
    });
    expect(all["appa-lisbon-seat"]).toEqual({
      devices: ["macbook", "pixel", "work-laptop"],
      brokeThrough: false,
    });
  });

  it("lets an escalation through a mute, to the rule's devices only", () => {
    const muted = routes(TOP_LEVEL, { "section:work": "none" });
    expect(muted["terminal-app-pilot"]).toEqual({ devices: ["pixel"], brokeThrough: false });
    expect(muted["merchant-portal-webhooks"]).toEqual({ kind: "muted", from: "section:work" });
  });
});
