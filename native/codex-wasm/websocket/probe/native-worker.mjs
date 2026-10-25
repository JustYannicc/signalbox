import { DurableObject } from "cloudflare:workers";
import probeModule from "./probe.wasm";
import guardModule from "./guard.wasm";
import { KernelFileSystem } from "./kernel/KernelFileSystem.js";
import { KernelWakeRegistry } from "./kernel/KernelWakeRegistry.js";
import { createKernelAsyncWasi } from "./kernel/KernelWasi.js";
import { KernelWebSocketHost } from "./kernel/KernelWebSocketHost.js";
import { guardPoll } from "./poll-guard.js";

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export class ProofObject extends DurableObject {
  async fetch() {
    try {
      const rows = [];
      for (const mode of [0, 2, 3]) {
        for (const alias of [false, true]) rows.push(await run(alias, mode));
      }
      return Response.json({
        ok: true,
        scope:
          "native WebSocketPair + actual eight-import host + WASI transport; not exec JSON-RPC endpoint",
        rows,
      });
    } catch (error) {
      return Response.json(
        { ok: false, error: String(error), stack: error.stack },
        { status: 500 },
      );
    }
  }
}
export default {
  fetch(request, env) {
    return env.PROOF.getByName("isolated-proof").fetch(request);
  },
};

async function run(alias, mode) {
  const events = [];
  const filesystem = new KernelFileSystem({ mounts: [] });
  const wakes = new KernelWakeRegistry();
  const kernel = createKernelAsyncWasi({ filesystem, wakes });
  let instance, resource, aliasFd, peer;
  const counters = {
    drops: 0,
    handshakeEnobufs: 0,
    receiveEnobufs: 0,
    nativeMessages: 0,
    closes: 0,
  };
  const host = new KernelWebSocketHost({
    memory: () => instance.exports.memory,
    descriptors: kernel.descriptors,
    route: ({ request, authority }) => {
      check(
        authority === "localhost" && new URL(request.url).pathname === "/exec",
        "unexpected route",
      );
      const pair = new WebSocketPair();
      pair[0].accept();
      peer = pair[1];
      peer.accept();
      peer.addEventListener("message", ({ data }) => {
        const expected = counters.nativeMessages++ === 0 ? "initialize" : "second";
        check(data === expected, "native peer received out-of-order frame");
        events.push("peer:" + data);
        if (data === (mode === 0 ? "second" : "initialize")) peer.send("r".repeat(8192));
      });
      peer.addEventListener("close", () => {
        counters.closes++;
        events.push("peer:close");
        peer.close(1000, "");
      });
      return {
        status: 101,
        headers: [
          ["set-cookie", "first=1"],
          ["set-cookie", "second=2"],
          ["x-padding", "p".repeat(8192)],
        ],
        webSocket: pair[0],
      };
    },
  });
  const imports = kernel.wasi.getImportObject();
  const polls = guardPoll(imports, undefined, 128, guardModule);
  imports.host_net = {
    net_send() {
      throw new Error("unexpected TCP import");
    },
  };
  imports.signalbox_ws_v1 = Object.fromEntries(
    Object.entries(host.imports).map(([name, fn]) => [
      name,
      (...args) => {
        const errno = fn(...args);
        if (name === "ws_open" && errno === 0) {
          const fd = new DataView(instance.exports.memory.buffer).getUint32(args[2], true);
          resource = kernel.descriptors.resource(fd);
          if (alias) aliasFd = kernel.descriptors.duplicate(fd);
        }
        if (name === "ws_handshake" && errno === 42) counters.handshakeEnobufs++;
        if (name === "ws_recv" && errno === 42) counters.receiveEnobufs++;
        if (name === "ws_drop") counters.drops++;
        return errno;
      },
    ]),
  );
  imports.signalbox_ws_probe = {
    record(event) {
      events.push("guest:" + event);
      if (event === 8 && alias) {
        check(!resource.disposed, "nonfinal guest drop closed resource");
        kernel.descriptors.close(aliasFd);
        aliasFd = undefined;
        check(resource.disposed, "final alias failed to close resource");
      }
    },
  };
  instance = new WebAssembly.Instance(probeModule, imports);
  try {
    await kernel.wasi.initialize(instance);
    check((await kernel.wasi.run(instance.exports.probe, mode)) === 0, "guest result");
    check(counters.nativeMessages === 2, "missing native messages");
    check(counters.drops === 1 && resource.disposed, "descriptor leak");
    check(
      counters.handshakeEnobufs === 1 && counters.receiveEnobufs === 1,
      "bounded copy not exercised",
    );
    check(counters.closes === 1, "native close missing or duplicated");
    check(wakes.size === 0, "wake token leak");
    return { alias, mode, ...counters, polls: polls(), events };
  } finally {
    if (aliasFd !== undefined) kernel.descriptors.close(aliasFd);
    await kernel.wasi.close();
    filesystem.dispose();
    wakes.dispose();
    try {
      peer?.close(1000, "");
    } catch {}
  }
}
