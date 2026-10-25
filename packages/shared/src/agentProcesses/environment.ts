export function trackedEnvironment(input: {
  environment: NodeJS.ProcessEnv;
  worktreePath: string;
  sessionId: string;
  ownerPid: number;
  preloadUrl: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.environment,
    SIGNALBOX_PROCESS_WORKTREE: input.worktreePath,
    SIGNALBOX_PROCESS_SESSION_ID: input.sessionId,
    SIGNALBOX_PROCESS_OWNER_PID: String(input.ownerPid),
    NODE_OPTIONS: [input.environment.NODE_OPTIONS, `--import=${JSON.stringify(input.preloadUrl)}`]
      .filter(Boolean)
      .join(" "),
  };
}

export function registeredPorts(environment: NodeJS.ProcessEnv): number[] {
  return [
    ...new Set(
      [environment.T3CODE_PORT, environment.PORT, environment.SIGNALBOX_PORT].flatMap((value) => {
        if (value === undefined || !/^\d+$/.test(value)) return [];
        const port = Number(value);
        return port > 0 && port < 65_536 ? [port] : [];
      }),
    ),
  ];
}
