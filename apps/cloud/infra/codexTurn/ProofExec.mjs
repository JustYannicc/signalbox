import { CodexExecHandler } from "../../src/kernel/CodexExecHandler.ts";
import { CodexExecSessions } from "../../src/kernel/CodexExecSessions.ts";
import { acceptCodexExecWebSocket } from "../../src/kernel/CodexExecWebSocket.ts";
import { KernelCommandExecutor } from "../../src/kernel/KernelCommandExecutor.ts";
import { KernelForwardingUnavailable } from "../../src/kernel/KernelCommandForwarder.ts";
import { KernelWebSocketHost } from "../../src/kernel/KernelWebSocketHost.ts";
import { proofEnvironment } from "./ProofWorkspace.mjs";

export function createProofExec({ filesystem, host, transcript, cleanupErrors }) {
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
        spawn: executor.spawn,
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

export function createProofWebSocket({
  memory,
  binding,
  sessions,
  context,
  modelRoute,
  execSocket,
}) {
  return new KernelWebSocketHost({
    memory,
    descriptors: binding.descriptors,
    route(input) {
      const { request } = input;
      if (request.url !== proofEnvironment.CODEX_EXEC_SERVER_URL) {
        if (modelRoute) return modelRoute(input);
        throw new Error("Unexpected WebSocket route");
      }
      execSocket?.opened();
      const observedSessions = execSocket
        ? new Proxy(sessions, {
            get(target, key) {
              if (key !== "connect") return Reflect.get(target, key, target);
              return (...args) => {
                const connection = target.connect(...args);
                return {
                  ...connection,
                  get closed() {
                    return connection.closed;
                  },
                  receive(text) {
                    execSocket.serverReceive();
                    return connection.receive(text);
                  },
                  disconnect() {
                    execSocket.serverClose();
                    return connection.disconnect();
                  },
                };
              };
            },
          })
        : sessions;
      const response = acceptCodexExecWebSocket(request, observedSessions, context);
      response.webSocket?.accept();
      if (response.webSocket && execSocket)
        return {
          status: response.status,
          headers: [],
          webSocket: execSocket.observe(response.webSocket),
        };
      return { response, headers: [] };
    },
  });
}
