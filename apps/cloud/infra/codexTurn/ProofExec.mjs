import { CodexExecHandler } from "../../src/kernel/CodexExecHandler.ts";
import { CodexExecSessions } from "../../src/kernel/CodexExecSessions.ts";
import { acceptCodexExecWebSocket } from "../../src/kernel/CodexExecWebSocket.ts";
import { KernelCommandExecutor } from "../../src/kernel/KernelCommandExecutor.ts";
import { KernelForwardingUnavailable } from "../../src/kernel/KernelCommandForwarder.ts";
import { KernelWebSocketHost } from "../../src/kernel/KernelWebSocketHost.ts";
import { proofEnvironment } from "./ProofWorkspace.mjs";

export function createProofExec({ filesystem, host, transcript, cleanupErrors, wrapCommands }) {
  const executor = new KernelCommandExecutor({
    host,
    filesystem,
    home: proofEnvironment.HOME,
    forwarder: {
      async spawn(command) {
        transcript.push({ direction: "unregistered-command", command });
        throw new KernelForwardingUnavailable(
          "RUNNER_NOT_READY",
          "This proof requires every command to execute in the isolate",
        );
      },
    },
  });
  const commands = wrapCommands?.({ exec: executor.spawn }) ?? { exec: executor.spawn };
  return new CodexExecSessions({
    environmentInfo: {
      shell: { name: "bash", path: "/bin/bash" },
      executorVersion: "0.0.0",
      cwd: "file:///workspace",
      userHomeDir: "file:///home/codex",
      platformOs: "linux",
      tempDir: "file:///tmp",
      capabilities: { tty: false },
    },
    createSession(context) {
      const handler = new CodexExecHandler({
        filesystem,
        spawn: commands.exec,
        notify: (message) => {
          transcript.push({ direction: "from-exec", message });
          return context.notify(message);
        },
        sessionSignal: context.signal,
        baseEnv: proofEnvironment,
        platformOs: "linux",
      });
      return {
        async request(method, params, signal) {
          transcript.push({ direction: "to-exec", method, params });
          try {
            const result = await handler.request(method, params, signal);
            transcript.push({ direction: "exec-result", method, result });
            return result;
          } catch (error) {
            transcript.push({ direction: "exec-error", method, error: String(error) });
            throw error;
          }
        },
        dispose: () => handler.dispose(),
      };
    },
    onCleanupError: (error) => cleanupErrors.push({ name: "exec-session", error: String(error) }),
  });
}

export function createProofWebSocket({ memory, binding, sessions, context }) {
  return new KernelWebSocketHost({
    memory,
    descriptors: binding.descriptors,
    route({ request }) {
      if (request.url !== proofEnvironment.CODEX_EXEC_SERVER_URL) {
        throw new Error("Unexpected WebSocket route");
      }
      const response = acceptCodexExecWebSocket(request, sessions, context);
      response.webSocket?.accept();
      return { response, headers: [] };
    },
  });
}
