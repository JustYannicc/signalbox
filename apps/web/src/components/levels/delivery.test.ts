import { describe, expect, it } from "vite-plus/test";

import { deliveryFor, devicesFor } from "./delivery";
import { escalates, matchingRules, type EscalationRule } from "./escalation";
import { TOP_LEVEL } from "./levels";

const PERSONAL = "section:personal";
const WORK = "section:work";
const NORTHWIND = "section:work-northwind";
const TERMINAL_APP = "team-project:terminal-app";
const MERCHANT_PORTAL = "team-project:merchant-portal";
const DOTFILES = "project:env:dotfiles";

const placement = { projectSectionOverrides: { "env:dotfiles": "personal" } };

const MAC = { id: "macbook", level: PERSONAL };
const PHONE = { id: "pixel", level: PERSONAL };
const WORK_LAPTOP = { id: "work-laptop", level: WORK };
const DESK = { id: "desk", level: TOP_LEVEL };
const DEVICES = [MAC, PHONE, WORK_LAPTOP, DESK];

const ids = (devices: readonly { id: string }[]) => devices.map((device) => device.id);
const route = (level: string, focus = TOP_LEVEL) =>
  ids(devicesFor(level, DEVICES, focus, placement));

const RULE: EscalationRule = {
  id: "terminal-app-urgent",
  level: TERMINAL_APP,
  statuses: ["approval", "failed"],
  deviceIds: ["pixel"],
};

describe("devicesFor", () => {
  it("sends a thing to devices at its level or above on its chain", () => {
    expect(route(DOTFILES)).toEqual(["macbook", "pixel", "desk"]);
    expect(route(TERMINAL_APP)).toEqual(["work-laptop", "desk"]);
    expect(route(WORK)).toEqual(["work-laptop", "desk"]);
  });

  it("sends top-level things to every device in sight", () => {
    expect(route(TOP_LEVEL)).toEqual(ids(DEVICES));
    expect(route(TOP_LEVEL, PERSONAL)).toEqual(["macbook", "pixel", "desk"]);
  });

  it("lands nothing about a thing Focus hides", () => {
    expect(route(TERMINAL_APP, PERSONAL)).toEqual([]);
    expect(route(DOTFILES, NORTHWIND)).toEqual([]);
    expect(route(TERMINAL_APP, NORTHWIND)).toEqual(["work-laptop", "desk"]);
  });
});

describe("matchingRules", () => {
  it("holds a rule at its level and everything inside, for its statuses only", () => {
    const sectionRule = { ...RULE, id: "northwind", level: NORTHWIND };
    expect(matchingRules({ levels: [TERMINAL_APP], status: "failed" }, [RULE])).toEqual([RULE]);
    expect(
      matchingRules({ levels: [MERCHANT_PORTAL], status: "approval" }, [RULE, sectionRule]),
    ).toEqual([sectionRule]);
    expect(matchingRules({ levels: [TERMINAL_APP], status: "input" }, [RULE])).toEqual([]);
    expect(matchingRules({ levels: [TERMINAL_APP], status: "working" }, [RULE])).toEqual([]);
    expect(matchingRules({ levels: [TERMINAL_APP], status: null }, [RULE])).toEqual([]);
  });

  it("matches a thing mapped into several levels by any of them", () => {
    expect(matchingRules({ levels: [DOTFILES, TERMINAL_APP], status: "approval" }, [RULE])).toEqual(
      [RULE],
    );
  });
});

describe("escalates", () => {
  it("breaks through Focus only when a rule holds", () => {
    const subject = { levels: [TERMINAL_APP], status: "approval" } as const;
    expect(escalates(subject, PERSONAL, [RULE])).toBe(true);
    expect(escalates({ ...subject, status: "working" }, PERSONAL, [RULE])).toBe(false);
    expect(escalates({ levels: [MERCHANT_PORTAL], status: "approval" }, PERSONAL, [RULE])).toBe(
      false,
    );
  });

  it("has nothing to break through under All", () => {
    expect(escalates({ levels: [TERMINAL_APP], status: "approval" }, TOP_LEVEL, [RULE])).toBe(
      false,
    );
  });
});

describe("deliveryFor", () => {
  it("sends an escalated thing to the rule's devices even while Focus hides it", () => {
    const delivery = deliveryFor(
      { levels: [TERMINAL_APP], status: "failed" },
      DEVICES,
      PERSONAL,
      [RULE],
      placement,
    );
    expect(ids(delivery.devices)).toEqual(["pixel"]);
    expect(delivery.escalatedBy).toEqual([RULE]);
  });

  it("adds the rule's devices to the usual route when nothing is hidden", () => {
    const delivery = deliveryFor(
      { levels: [TERMINAL_APP], status: "approval" },
      DEVICES,
      TOP_LEVEL,
      [RULE],
      placement,
    );
    expect(ids(delivery.devices)).toEqual(["pixel", "work-laptop", "desk"]);
  });

  it("keeps hidden things that don't escalate off every device", () => {
    const delivery = deliveryFor(
      { levels: [TERMINAL_APP], status: "working" },
      DEVICES,
      PERSONAL,
      [RULE],
      placement,
    );
    expect(delivery).toEqual({ devices: [], escalatedBy: [] });
  });

  it("lets each device's own setting filter its route, but not an escalation", () => {
    const urgentPhone = { ...PHONE, notify: "urgent" as const };
    const offMac = { ...MAC, notify: "none" as const };
    const devices = [offMac, urgentPhone, WORK_LAPTOP];
    const update = deliveryFor(
      { levels: [DOTFILES], status: null },
      devices,
      TOP_LEVEL,
      [],
      placement,
    );
    expect(ids(update.devices)).toEqual([]);
    const failure = deliveryFor({ levels: [DOTFILES], status: "failed" }, devices, TOP_LEVEL, []);
    expect(ids(failure.devices)).toEqual(["pixel"]);
    const ruleToMac = { ...RULE, deviceIds: ["macbook"] };
    const escalated = deliveryFor(
      { levels: [TERMINAL_APP], status: "approval" },
      devices,
      PERSONAL,
      [ruleToMac],
      placement,
    );
    expect(ids(escalated.devices)).toEqual(["macbook"]);
  });

  it("treats a subject with no levels as top level", () => {
    const delivery = deliveryFor({ levels: [], status: null }, DEVICES, WORK, [RULE], placement);
    expect(ids(delivery.devices)).toEqual(["work-laptop", "desk"]);
  });
});
