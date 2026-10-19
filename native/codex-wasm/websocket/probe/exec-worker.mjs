import { DurableObject } from "cloudflare:workers";
import probeModule from "./probe.wasm";
import guardModule from "./guard.wasm";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "./kernel/KernelAbi.js";
import { KernelFileSystem } from "./kernel/KernelFileSystem.js";
import { KernelProgramHost } from "./kernel/KernelProgramHost.js";
import { createKernelAsyncWasi } from "./kernel/KernelWasi.js";
import { KernelWebSocketHost } from "./kernel/KernelWebSocketHost.js";
import { KernelCommandExecutor } from "./kernel/KernelCommandExecutor.js";
import { KernelForwardingUnavailable } from "./kernel/KernelCommandForwarder.js";
import { CodexExecProcesses } from "./kernel/CodexExecProcesses.js";
import { CodexExecSessions } from "./kernel/CodexExecSessions.js";
import { acceptCodexExecWebSocket } from "./kernel/CodexExecWebSocket.js";
import { createFacetSqliteStorage } from "./kernel/FacetSqliteStorage.js";
import { guardPoll } from "./poll-guard.js";

const check = (condition, message) => { if (!condition) throw new Error(message); };
export class ProofObject extends DurableObject {
  async fetch() {
    const events = [];
    try {
      const storage = createFacetSqliteStorage(this.ctx.storage, () => BigInt(Date.now()) * 1_000_000n);
      const result = await run(storage, this.ctx, events);
      return Response.json({ ok: true, scope: "minimal Rust WASI guest through actual exec JSON-RPC WebSocket endpoint and registered JS program; not full Codex engine", ...result, events });
    } catch (error) {
      return Response.json({ ok: false, error: String(error), stack: error.stack, events }, { status: 500 });
    }
  }
}
export default { fetch(request, env) { return env.PROOF.getByName("isolated-proof").fetch(request); } };

async function run(storage, lifetime, events) {
  const stderr = (bytes) => { events.push("stderr:" + new TextDecoder().decode(bytes)); return bytes.length; };
  const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }], stdio: [{}, { write: stderr }, { write: stderr }] });
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const counters = { programRuns: 0, forwarded: 0, opens: 0, drops: 0, outputBytes: 0 };
  const binding = {
    manifest: { name: "exec-proof", version: "1.0.0", abiVersion: ABI_VERSION, requiredCapabilities: [], entrypoint: "exec-proof-js-v1" },
    implementation: { kind: "javascript", runInline(context) {
      counters.programRuns++;
      check(context.filesystem.cwd === "/workspace", "incorrect program cwd");
      const bytes = new TextEncoder().encode("kernel-proof");
      const written = context.filesystem.write(1, bytes, null);
      check(written === bytes.length, "registered program stdout write failed");
      counters.outputBytes += written;
      return 17;
    } },
  };
  check(registry.register(binding.manifest).status === "ok", "program registration failed");
  const programs = new Map([["/bin/proof", binding]]);
  const programHost = new KernelProgramHost({ registry, wakes, programs });
  const executor = new KernelCommandExecutor({ host: programHost, filesystem, forwarder: { spawn: async () => {
    counters.forwarded++;
    throw new KernelForwardingUnavailable("WORKSPACE_NOT_READY", "This proof only runs its registered program");
  } } });
  const cleanupErrors = [];
  const sessions = new CodexExecSessions({
    environmentInfo: { shell: { name: "sh", path: "/bin/sh" }, executorVersion: "0.0.0", capabilities: { tty: false } },
    createSession: (context) => new CodexExecProcesses({ spawn: executor.spawn, notify: context.notify, sessionSignal: context.signal, baseEnv: {} }),
    onCleanupError: (error) => cleanupErrors.push(String(error)),
  });
  const kernel = createKernelAsyncWasi({ filesystem, wakes });
  let instance, resource;
  const host = new KernelWebSocketHost({ memory: () => instance.exports.memory, descriptors: kernel.descriptors,
    route: ({ request, authority }) => {
      check(authority === "localhost" && new URL(request.url).pathname === "/exec", "unexpected route");
      check(request.headers.get("Upgrade")?.toLowerCase() === "websocket", "missing upgrade header");
      const response = acceptCodexExecWebSocket(request, sessions, lifetime);
      response.webSocket?.accept();
      return { response, headers: [] };
    },
  });
  const imports = kernel.wasi.getImportObject();
  const polls = guardPoll(imports, undefined, 128, guardModule);
  imports.host_net = { net_send() { throw new Error("unexpected TCP import"); } };
  imports.signalbox_ws_v1 = Object.fromEntries(Object.entries(host.imports).map(([name, fn]) => [name, (...args) => {
    const errno = fn(...args);
    if (name === "ws_open" && errno === 0) {
      counters.opens++;
      const fd = new DataView(instance.exports.memory.buffer).getUint32(args[2], true);
      resource = kernel.descriptors.resource(fd);
    }
    if (name === "ws_drop") counters.drops++;
    return errno;
  }]));
  const milestones = { 9: "done", 20: "initialize", 21: "initialized", 22: "start", 23: "output", 24: "exited", 25: "closed", 26: "read", 27: "transport-closed", 28: "transport-dropped" };
  imports.signalbox_ws_probe = { record(event) { check(milestones[event], "unexpected guest milestone"); events.push("guest:" + milestones[event]); } };
  instance = new WebAssembly.Instance(probeModule, imports);
  try {
    try { filesystem.mkdir("/workspace"); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await kernel.wasi.initialize(instance);
    check(await kernel.wasi.run(instance.exports.probe, 5) === 0, "guest result");
    check(counters.programRuns === 1 && counters.forwarded === 0, "program execution or registry routing failed");
    check(counters.outputBytes === 12, "program output length");
    check(counters.opens === 1 && counters.drops === 1 && resource.disposed, "WebSocket descriptor leaked");
    check(events.includes("guest:read") && events.includes("guest:done"), "protocol milestones incomplete");
    await sessions.dispose();
    check(cleanupErrors.length === 0, "session cleanup failed: " + cleanupErrors.join("; "));
    check(wakes.size === 0, "wake token leaked");
    return { ...counters, polls: polls(), wakeTokens: wakes.size, exitCode: 17, stdout: "kernel-proof" };
  } finally {
    await sessions.dispose();
    await kernel.wasi.close();
    filesystem.dispose();
    wakes.dispose();
  }
}
