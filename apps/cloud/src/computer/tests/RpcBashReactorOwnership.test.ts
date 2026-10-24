// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort, KernelBashOperation } from "../../kernel/KernelBashPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error("Required GNU Bash artifact is missing");
const module = available
  ? (() => {
      const bytes = NodeFS.readFileSync(artifact);
      if (
        bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
      )
        throw new Error("GNU Bash artifact does not match its pin");
      return new WebAssembly.Module(bytes);
    })()
  : undefined;

function replies() {
  const received: { method: string; dispose: ReturnType<typeof vi.fn> }[] = [];
  function own<Value extends object>(method: string, value: Value) {
    const dispose = vi.fn();
    received.push({ method, dispose });
    return Object.assign(value, { [Symbol.dispose]: dispose });
  }
  return { received, own };
}

describe.skipIf(!available)("Bash reactor RPC reply ownership", () => {
  it("releases a pending operation reply before transferring its checkpoint", async () => {
    const fixture = childBashFixture({ args: ["bash", "-c", "printf marker"] });
    const dispose = vi.fn();
    const parked = vi.fn();
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: {
        ...fixture.owner.port,
        startOperation: async () => ({
          kind: "pending",
          id: "pending-reply",
          [Symbol.dispose]: dispose,
        }),
        async park(source, operationId) {
          expect(dispose).toHaveBeenCalledOnce();
          parked(operationId);
          await source.restored();
        },
      },
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      expect(await reactor.run()).toEqual(exited());
      await reactor.drain();
      expect(parked).toHaveBeenCalledWith("pending-reply");
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it("releases an operation reply before rejecting a mismatched result", async () => {
    const fixture = childBashFixture({ args: ["bash", "-c", "true"] });
    void fixture.owner.exited.catch(() => {});
    const dispose = vi.fn();
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: {
        ...fixture.owner.port,
        startOperation: async () => ({
          kind: "ready",
          result: { kind: "wait", value: { kind: "error", errno: 6 } },
          [Symbol.dispose]: dispose,
        }),
      },
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      await expect(reactor.run()).rejects.toThrow("operation received wait result");
      await reactor.drain();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it.each([false, true])("consumes execution replies with operation bridge %s", async (bridge) => {
    const fixture = childBashFixture({
      args: ["bash", "-c", "printf marker > /workspace/marker; (exit 4) & wait $!; exec /bin/tool"],
      exec: async () => exited(17),
    });
    const { received, own } = replies();
    function wrap(port: KernelBashPort): KernelBashPort {
      const wrapped: KernelBashPort = {
        ...port,
        call: async (request) => own("call", await port.call(request)),
        callBash: async (request) => own("callBash", await port.callBash(request)),
        wait: async (pid, options) => own("wait", await port.wait(pid, options)),
        exec: async (request) => own("exec", await port.exec(request)),
        async fork() {
          const forked = await port.fork();
          return own(
            "fork",
            forked.kind === "error" ? forked : { ...forked, port: wrap(forked.port) },
          );
        },
      };
      if (bridge) {
        return {
          ...wrapped,
          async startOperation(operation: KernelBashOperation) {
            switch (operation.kind) {
              case "wasi":
                return own("startOperation:wasi", {
                  kind: "ready",
                  result: { kind: "wasi", value: await port.call(operation.request) },
                });
              case "bash":
                return own("startOperation:bash", {
                  kind: "ready",
                  result: { kind: "bash", value: await port.callBash(operation.request) },
                });
              case "wait":
                return own("startOperation:wait", {
                  kind: "ready",
                  result: {
                    kind: "wait",
                    value: await port.wait(operation.pid, operation.options),
                  },
                });
              case "exec":
                return own("startOperation:exec", {
                  kind: "ready",
                  result: { kind: "exec", value: await port.exec(operation.request) },
                });
            }
          },
        };
      }
      return wrapped;
    }
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: wrap(fixture.owner.port),
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      expect(await reactor.run()).toEqual(exited(17));
      await reactor.drain();
      expect(fixture.read("/workspace/marker")).toBe("marker");
      expect(fixture.stderr()).toBe("");
      const methods = new Set(received.map(({ method }) => method));
      for (const method of bridge
        ? [
            "startOperation:wasi",
            "startOperation:bash",
            "startOperation:wait",
            "startOperation:exec",
            "fork",
          ]
        : ["call", "callBash", "wait", "exec", "fork"])
        expect(methods.has(method), method).toBe(true);
      expect(
        received
          .filter(({ dispose }) => dispose.mock.calls.length !== 1)
          .map(({ method }) => method),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("consumes a fork refusal without closing an unrelated capability", async () => {
    const fixture = childBashFixture({ args: ["bash", "-c", "(true)"] });
    const { received, own } = replies();
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: {
        ...fixture.owner.port,
        fork: async () => own("fork:error", { kind: "error", errno: 29 }),
      },
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      await reactor.run();
      await reactor.drain();
      expect(received).toHaveLength(1);
      expect(received[0]!.dispose).toHaveBeenCalledOnce();
      expect(fixture.stderr()).toContain("fork:");
    } finally {
      await fixture.close();
    }
  });

  it("releases a fork reply when reading its variant fails", async () => {
    const fixture = childBashFixture({ args: ["bash", "-c", "(true)"] });
    void fixture.owner.exited.catch(() => {});
    const dispose = vi.fn();
    const reply = {
      get kind(): "error" {
        throw new Error("fork reply decode failed");
      },
      errno: 29,
      [Symbol.dispose]: dispose,
    };
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: { ...fixture.owner.port, fork: async () => reply },
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      await expect(reactor.run()).rejects.toThrow("fork reply decode failed");
      await reactor.drain();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  });

  it.each([false, true])(
    "consumes remote fork status after restore acknowledgement %s",
    async (restored) => {
      const fixture = childBashFixture({ args: ["bash", "-c", "(exit 0) & wait $!"] });
      const { received, own } = replies();
      function wrap(port: KernelBashPort): KernelBashPort {
        return {
          ...port,
          wait: async (pid, options) => own("wait", await port.wait(pid, options)),
          async fork() {
            const forked = await port.fork();
            if (forked.kind === "error") return forked;
            return {
              ...forked,
              port: {
                ...forked.port,
                async runFork(source) {
                  if (restored) await source.restored();
                  await forked.port.complete({ kind: "exit", status: exited() });
                  return own("runFork", exited());
                },
              },
            };
          },
        };
      }
      const reactor = createChildBash({
        module: module!,
        credentials: bashCredentials,
        pid: fixture.owner.pid,
        port: wrap(fixture.owner.port),
        args: fixture.context.args,
        env: fixture.context.env,
        localForkPackingBytes: 0,
      });
      try {
        await reactor.run();
        await reactor.drain();
        expect(received.filter(({ method }) => method === "runFork")).toHaveLength(1);
        expect(
          received
            .filter(({ dispose }) => dispose.mock.calls.length !== 1)
            .map(({ method }) => method),
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["rejected", "exited-before-restore"] as const)(
    "disposes the cleanup wait reply after a remote fork %s",
    async (mode) => {
      const fixture = childBashFixture({ args: ["bash", "-c", "(exit 0)"] });
      const disposeWait = vi.fn();
      const restored = vi.fn();
      let remoteFinished = false;
      let cleanupWaits = 0;
      const reactor = createChildBash({
        module: module!,
        credentials: bashCredentials,
        pid: fixture.owner.pid,
        args: fixture.context.args,
        env: fixture.context.env,
        localForkPackingBytes: 0,
        createForkSource(source) {
          return {
            state: () => source.state(),
            read: (offset, length) => source.read(offset, length),
            async restored() {
              restored();
              await source.restored();
            },
          };
        },
        port: {
          ...fixture.owner.port,
          async fork() {
            const forked = await fixture.owner.port.fork();
            if (forked.kind === "error") return forked;
            return {
              ...forked,
              port: {
                ...forked.port,
                async runFork() {
                  await forked.port.complete({ kind: "exit", status: exited() });
                  remoteFinished = true;
                  if (mode === "rejected")
                    throw Object.assign(new Error("restore failed"), { code: "EIO" });
                  return exited();
                },
              },
            };
          },
          async wait(pid, options) {
            expect(remoteFinished).toBe(true);
            expect(restored).not.toHaveBeenCalled();
            expect(options).toBe(0);
            cleanupWaits++;
            const reply = await fixture.owner.port.wait(pid, options);
            Object.defineProperty(reply, Symbol.dispose, { value: disposeWait });
            return reply;
          },
        },
      });
      try {
        await reactor.run();
        await reactor.drain();
        expect(cleanupWaits).toBe(1);
        expect(disposeWait).toHaveBeenCalledOnce();
        expect(restored).not.toHaveBeenCalled();
        expect(fixture.stderr()).toContain("fork:");
        expect(fixture.processes.size).toBe(1);
      } finally {
        await fixture.close();
      }
    },
  );
});
