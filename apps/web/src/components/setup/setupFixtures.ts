/**
 * PLACEHOLDER DATA for the agent-first `/setup` prototype. The CLI, MCP
 * server, and skill don't exist yet; the commands show the intended shape.
 * `SETUP_PROMPT` is the one onboarding prompt; other pages (Team) reuse it.
 */

export const PRODUCT_NAME = "Signalbox";
/** Placeholder npm package for the agent-facing CLI. */
export const CLI_PACKAGE = "signalbox";

export const SKILL_INSTALL = `npx skills add ${CLI_PACKAGE}/skills`;

export const SETUP_PROMPT = `Set up ${PRODUCT_NAME} for me. Run each command yourself and only stop when I need to sign in, scan something, or answer a question.

1. Install the CLI and sign in (opens WorkOS in my browser):
   npx -y ${CLI_PACKAGE}@latest login

2. Give yourself the tools. Register the MCP server with your own MCP command, e.g.:
   codex mcp add ${CLI_PACKAGE} -- npx -y ${CLI_PACKAGE} mcp
   claude mcp add ${CLI_PACKAGE} -- npx -y ${CLI_PACKAGE} mcp
   Then install the skill:
   ${SKILL_INSTALL}

3. Ask me what to call my assistant, then:
   npx ${CLI_PACKAGE} assistant name "<name>"

4. Ask which sections I want (suggest Work and Personal), then:
   npx ${CLI_PACKAGE} sections create "Work" "Personal"

5. Connect my model accounts through CLIProxyAPI and my tools through Executor:
   npx ${CLI_PACKAGE} accounts connect codex claude grok
   npx ${CLI_PACKAGE} executor connect

6. Pair my phone. Show me the QR code this prints:
   npx ${CLI_PACKAGE} devices pair

7. Set up Focus. Ask my working hours, then:
   npx ${CLI_PACKAGE} focus set work --hours "Mon-Fri 08:00-18:00"

8. Verify with a test workflow and read the diagnosis:
   npx ${CLI_PACKAGE} workflows create --template hello-world
   npx ${CLI_PACKAGE} runs trigger hello-world --wait
   npx ${CLI_PACKAGE} diagnose --json

Finish with a short summary of what's connected and anything that failed.`;

export interface SetupStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/** What the prompt has the agent do, in order. No status: nothing has run yet. */
export const SETUP_STEPS: ReadonlyArray<SetupStep> = [
  { id: "sign-in", label: "Sign in", detail: "WorkOS, in your browser." },
  { id: "tools", label: "Install the CLI, MCP server, and skill", detail: "In your agent." },
  { id: "assistant", label: "Name your assistant", detail: "It asks you what to call it." },
  { id: "sections", label: "Create sections", detail: "Work and Personal to start." },
  {
    id: "accounts",
    label: "Connect accounts and tools",
    detail: "Codex, Claude, and Grok through CLIProxyAPI; tools through Executor.",
  },
  { id: "phone", label: "Pair your phone", detail: "You scan a QR code." },
  { id: "focus", label: "Set up Focus", detail: "Work stays out of sight after hours." },
  { id: "verify", label: "Run a test workflow", detail: "Proves everything is wired up." },
];

export interface SetupCommand {
  readonly command: string;
  readonly purpose: string;
}

export const CLI_COMMANDS: ReadonlyArray<SetupCommand> = [
  { command: `npx ${CLI_PACKAGE} workflows list`, purpose: "Discover" },
  { command: `npx ${CLI_PACKAGE} workflows create <file>`, purpose: "Create" },
  { command: `npx ${CLI_PACKAGE} workflows inspect <id>`, purpose: "Inspect" },
  { command: `npx ${CLI_PACKAGE} workflows validate <id>`, purpose: "Validate" },
  { command: `npx ${CLI_PACKAGE} workflows deploy <id>`, purpose: "Update and deploy" },
  { command: `npx ${CLI_PACKAGE} runs trigger <id>`, purpose: "Trigger" },
  { command: `npx ${CLI_PACKAGE} workflows pause <id>`, purpose: "Pause" },
  { command: `npx ${CLI_PACKAGE} diagnose <run-id> --json`, purpose: "Diagnose" },
];

export type McpClient = "codex" | "claude-code" | "other";

export const MCP_CLIENTS: ReadonlyArray<{ value: McpClient; label: string; snippet: string }> = [
  {
    value: "codex",
    label: "Codex",
    snippet: `codex mcp add ${CLI_PACKAGE} -- npx -y ${CLI_PACKAGE} mcp`,
  },
  {
    value: "claude-code",
    label: "Claude Code",
    snippet: `claude mcp add ${CLI_PACKAGE} -- npx -y ${CLI_PACKAGE} mcp`,
  },
  {
    value: "other",
    label: "Other",
    snippet: `{
  "mcpServers": {
    "${CLI_PACKAGE}": {
      "command": "npx",
      "args": ["-y", "${CLI_PACKAGE}", "mcp"]
    }
  }
}`,
  },
];
