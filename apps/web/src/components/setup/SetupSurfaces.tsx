/**
 * The three agent-facing surfaces. Everything the UI shows is reachable from
 * each of them, so agents never need to scrape the app to diagnose a run.
 */
import { useState, type ReactNode } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { CopyableCode } from "./CopyableCode";
import { CLI_COMMANDS, MCP_CLIENTS, SKILL_INSTALL, type McpClient } from "./setupFixtures";

function isMcpClient(value: string | undefined): value is McpClient {
  return MCP_CLIENTS.some((client) => client.value === value);
}

function McpSnippet() {
  const [client, setClient] = useState<McpClient>("codex");
  const selected = MCP_CLIENTS.find((option) => option.value === client) ?? MCP_CLIENTS[0]!;
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        aria-label="Agent"
        value={[client]}
        onValueChange={(next) => {
          const value = next[0];
          if (isMcpClient(value)) setClient(value);
        }}
      >
        {MCP_CLIENTS.map((option) => (
          <Toggle key={option.value} value={option.value}>
            {option.label}
          </Toggle>
        ))}
      </ToggleGroup>
      <CopyableCode label={`${selected.label} MCP setup`} value={selected.snippet} />
    </div>
  );
}

function Surface({
  id,
  name,
  summary,
  children,
}: {
  id: string;
  name: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id={id} className="text-sm font-medium text-foreground">
          {name}
        </h3>
        <p className="text-xs text-muted-foreground">{summary}</p>
      </div>
      {children}
    </section>
  );
}

export function SetupSurfaces() {
  return (
    <section aria-labelledby="setup-surfaces" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="setup-surfaces" className="text-sm font-medium text-foreground">
          Or wire it up yourself
        </h2>
        <p className="text-xs text-muted-foreground">
          The prompt uses these. Agents can discover, create, inspect, validate, update, deploy,
          trigger, pause, and diagnose workflows through any of them.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Surface
          id="setup-cli"
          name="CLI"
          summary="Every command takes --json, so output is safe to parse."
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {CLI_COMMANDS.map((entry) => (
              <div key={entry.command} className="contents">
                <dt className="text-muted-foreground">{entry.purpose}</dt>
                <dd className="m-0 truncate font-mono text-foreground">{entry.command}</dd>
              </div>
            ))}
          </dl>
        </Surface>
        <div className="flex min-w-0 flex-col gap-3">
          <Surface
            id="setup-mcp"
            name="MCP"
            summary="Same operations as tools, for agents that speak MCP."
          >
            <McpSnippet />
          </Surface>
          <Surface
            id="setup-skill"
            name="Skill"
            summary="Teaches the agent when and how to use the CLI and MCP tools."
          >
            <CopyableCode label="skill install command" value={SKILL_INSTALL} />
          </Surface>
        </div>
      </div>
    </section>
  );
}
