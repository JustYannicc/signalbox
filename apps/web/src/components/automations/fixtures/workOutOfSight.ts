/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation, NodeRunResult, WorkflowNode } from "../automationModel";
import { lastDailyAt, ok, run, shiftDays, skipped } from "./fixtureHelpers";

const SOURCE = `import { notify, tool } from "@signalbox/automations";
import { client } from "@signalbox/automations/triggers";

// Clients only report these signals. The Signalbox server runs the workflow.
export const triggers = [
  client("MacBook Pro").time({ after: "17:00", days: "weekdays" }),
  client("MacBook Pro").wifi({ left: "northwind-office" }),
  client("Pixel 8 Pro").nfc({ tag: "desk" }),
];

export async function workOutOfSight() {
  "use workflow";

  const { focus } = await tool("Signalbox", "getFocus", {}, { via: "Signalbox server" });
  if (focus !== "Work") return;

  await tool(
    "Signalbox",
    "setFocus",
    { focus: "Personal", hide: ["Work sections"], mute: ["Work notifications"] },
    { via: "Signalbox server" },
  );
  await notify("Work is out of sight. Personal Focus is on.");
}
`;

const nodes: WorkflowNode[] = [
  {
    id: "time",
    title: "After 17:00 on a weekday",
    x: 0,
    y: 0,
    config: {
      kind: "clientSignal",
      device: "MacBook Pro",
      deviceKind: "laptop",
      signal: "time",
      condition: "Local time passes 17:00, Monday to Friday",
    },
  },
  {
    id: "wifi",
    title: "Left 'northwind-office' Wi-Fi",
    x: 0,
    y: 110,
    config: {
      kind: "clientSignal",
      device: "MacBook Pro",
      deviceKind: "laptop",
      signal: "wifi",
      condition: "Disconnects from the northwind-office network",
    },
  },
  {
    id: "nfc",
    title: "NFC tag 'desk' tapped",
    x: 0,
    y: 220,
    config: {
      kind: "clientSignal",
      device: "Pixel 8 Pro",
      deviceKind: "phone",
      signal: "nfc",
      condition: "The tag labeled 'desk' is tapped",
    },
  },
  {
    id: "inWork",
    title: "Still in Work Focus?",
    x: 320,
    y: 110,
    config: {
      kind: "condition",
      expression: 'focus == "Work"',
      trueLabel: "Work",
      falseLabel: "Already Personal",
    },
  },
  {
    id: "switch",
    title: "Switch Focus to Personal",
    x: 640,
    y: 50,
    config: {
      kind: "tool",
      integration: "Signalbox",
      action: "Set Focus",
      via: "Signalbox server",
      params: { focus: "Personal", hide: ["Work sections"], mute: ["Work notifications"] },
    },
  },
  {
    id: "notify",
    title: "Confirm on my devices",
    x: 960,
    y: 50,
    config: {
      kind: "notify",
      importance: "low",
      message: "Work is out of sight. Personal Focus is on.",
    },
  },
];

type Signal = "time" | "wifi" | "nfc";

function focusRun(
  daysBack: number,
  hour: number,
  signal: Signal,
  title: string,
  alreadyPersonal = false,
) {
  const fired = (id: Signal): NodeRunResult =>
    id === signal ? ok(1, { device: id === "nfc" ? "Pixel 8 Pro" : "MacBook Pro" }) : skipped;
  return run(
    `focus-${daysBack}-${signal}`,
    title,
    shiftDays(lastDailyAt(hour), -daysBack),
    {
      time: fired("time"),
      wifi: fired("wifi"),
      nfc: fired("nfc"),
      inWork: ok(40, {
        focus: alreadyPersonal ? "Personal" : "Work",
        branch: alreadyPersonal ? "false" : "true",
      }),
      switch: alreadyPersonal ? skipped : ok(120, { focus: "Personal", hiddenSections: 3 }),
      notify: alreadyPersonal ? skipped : ok(180, { delivered: 2 }),
    },
    "device",
  );
}

export const WORK_OUT_OF_SIGHT: Automation = {
  id: "work-out-of-sight",
  name: "Work out of sight",
  description: "Switches Focus to Personal when your devices say the workday is over.",
  agentName: "Focus agent",
  section: "personal",
  cadence: "On client signal",
  enabled: true,
  nextRunAt: null,
  source: { path: "automations/work-out-of-sight.ts", code: SOURCE },
  nodes,
  edges: [
    { from: "time", to: "inWork" },
    { from: "wifi", to: "inWork" },
    { from: "nfc", to: "inWork" },
    { from: "inWork", to: "switch", branch: "true" },
    { from: "switch", to: "notify" },
  ],
  runs: [
    focusRun(0, 17, "wifi", "Left the office Wi-Fi, Personal Focus on"),
    focusRun(1, 18, "nfc", "Tapped the desk tag, Personal Focus on"),
    focusRun(2, 17, "time", "17:00, already in Personal Focus", true),
    focusRun(3, 17, "time", "17:00, Personal Focus on"),
  ],
};
