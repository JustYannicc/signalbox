/** PLACEHOLDER DATA: see automationFixtures.ts. */
import type { Automation } from "../automationModel";
import { lastWeeklyAt, ok, run } from "./fixtureHelpers";

const SOURCE = `import { tool } from "@signalbox/automations";
import { schedule } from "@signalbox/automations/triggers";

// Imported from a recurring Todoist task.
export const trigger = schedule("0 10 * * 0", { timezone: "Europe/Zurich" });

export async function waterPlants() {
  "use workflow";

  await tool("Signalbox", "createTask", { title: "Water the plants", section: "Personal" });
}
`;

export const WATER_PLANTS: Automation = {
  id: "water-plants",
  name: "Water plants",
  description: "A recurring task that used to live in Todoist.",
  agentName: "Plant reminder agent",
  section: "personal",
  cadence: "Every Sunday at 10:00 AM",
  enabled: true,
  nextRunAt: lastWeeklyAt(0, 10, -1).toISOString(),
  source: { path: "automations/water-plants.ts", code: SOURCE },
  nodes: [
    {
      id: "trigger",
      title: "Every Sunday at 10:00 AM",
      x: 0,
      y: 40,
      config: {
        kind: "trigger",
        source: "schedule",
        cron: "0 10 * * 0",
        timezone: "Europe/Zurich",
        summary: "Weekly on Sunday",
      },
    },
    {
      id: "task",
      title: "Create a task in Personal",
      x: 300,
      y: 40,
      config: {
        kind: "tool",
        integration: "Signalbox",
        action: "Create task",
        via: "Signalbox server",
        params: { title: "Water the plants", section: "Personal" },
      },
    },
  ],
  edges: [{ from: "trigger", to: "task" }],
  runs: [0, 1, 2, 3].map((weeksBack) =>
    run(`plants-${weeksBack}`, "Task: water the plants", lastWeeklyAt(0, 10, weeksBack), {
      trigger: ok(2),
      task: ok(160, { task: "Water the plants", section: "Personal" }),
    }),
  ),
};
