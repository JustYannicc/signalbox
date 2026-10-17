import { createFileRoute } from "@tanstack/react-router";

import { AutomationStepsPage } from "../components/automations/AutomationStepsPage";

// Automations live in their Home folders; this route is only the reference of
// every trigger and step an automation can use.
export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationStepsPage,
});
