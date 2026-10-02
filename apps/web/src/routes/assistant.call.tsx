import { createFileRoute } from "@tanstack/react-router";

import { AssistantCallPage } from "../components/assistant/AssistantCallPage";

export const Route = createFileRoute("/assistant/call")({
  component: AssistantCallPage,
});
