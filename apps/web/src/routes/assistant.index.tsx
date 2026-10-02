import { createFileRoute } from "@tanstack/react-router";

import { AssistantPage } from "../components/assistant/AssistantPage";
import { validateAssistantSearch } from "../components/assistant/assistantModel";

export const Route = createFileRoute("/assistant/")({
  validateSearch: validateAssistantSearch,
  component: AssistantPage,
});
