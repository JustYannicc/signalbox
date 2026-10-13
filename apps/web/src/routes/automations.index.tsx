import { createFileRoute } from "@tanstack/react-router";

import { PrimitivesReferencePage } from "../components/automations/PrimitivesReference";

// Automations live in Home folders; `/automations` is only the reference of
// every hook and step a workflow can use.
export const Route = createFileRoute("/automations/")({
  component: PrimitivesReferencePage,
});
