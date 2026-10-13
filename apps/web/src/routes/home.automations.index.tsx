import { createFileRoute } from "@tanstack/react-router";

import { PrimitivesReferencePage } from "../components/homeAutomations/PrimitivesReference";

// Prototype automations live in Home folders; `/home/automations` is only the reference of
// every hook and step a workflow can use.
export const Route = createFileRoute("/home/automations/")({
  component: PrimitivesReferencePage,
});
