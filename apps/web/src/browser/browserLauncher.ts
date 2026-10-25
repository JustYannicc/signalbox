export function browserLauncher(input: {
  desktop: boolean;
  serverBrowser: boolean;
  agentBrowser: boolean;
  canOperatePreview: boolean;
  canReadAgentBrowser: boolean;
}) {
  const agentMirror = input.agentBrowser && !input.desktop && !input.serverBrowser;
  return {
    target: agentMirror ? ("agent-browser" as const) : ("preview" as const),
    available: input.desktop || input.serverBrowser || input.agentBrowser,
    profilesAvailable: !agentMirror,
    permitted: agentMirror ? input.canReadAgentBrowser : input.canOperatePreview,
  };
}
