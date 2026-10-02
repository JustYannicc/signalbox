import { createFileRoute } from "@tanstack/react-router";

import { AgentPage } from "../components/assistant/AgentPage";
import { validateAgentSearch } from "../components/assistant/agentFixtures";

function AgentRoute() {
  const { agentId } = Route.useParams();
  const { chat, prompt } = Route.useSearch();
  return (
    <AgentPage
      key={`${agentId}:${prompt ?? ""}`}
      agentId={agentId}
      chatId={chat ?? null}
      initialPrompt={prompt ?? ""}
    />
  );
}

export const Route = createFileRoute("/agent/$agentId")({
  validateSearch: validateAgentSearch,
  component: AgentRoute,
});
