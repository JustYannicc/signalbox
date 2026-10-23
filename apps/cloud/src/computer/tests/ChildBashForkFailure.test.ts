// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error("Required GNU Bash artifact is missing");
const module = available ? new WebAssembly.Module(NodeFS.readFileSync(artifact)) : undefined;

describe.skipIf(!available)("Bash fork placement failure", () => {
  it("reports a child killed after restore through wait status while the parent continues", async () => {
    const fixture = childBashFixture({
      args: ["bash", "-c", '(exit 0) & pid=$!; wait "$pid"; printf "wait:%s|alive" "$?"'],
    });
    const owner = createKernelBashHost({
      context: fixture.context,
      credentials: bashCredentials,
      async runFork(_context, _owner, snapshot) {
        await snapshot.restored();
        return { exitCode: 0, signal: 9, coreDumped: false };
      },
    });
    const reactor = createChildBash({
      module: module!,
      credentials: bashCredentials,
      pid: owner.pid,
      port: owner.port,
      args: fixture.context.args,
      env: fixture.context.env,
      residentWasmBudgetBytes: 0,
    });
    try {
      await expect(reactor.run()).resolves.toEqual(exited());
      await reactor.drain();
      expect(fixture.stdout()).toBe("wait:137|alive");
      expect(fixture.stderr()).not.toMatch(/exceededMemory|memory limit|isolate/);
      expect(fixture.processes.size).toBe(1);
    } finally {
      await owner.close();
      await fixture.close();
    }
  });
  it.each(["reject", "exit"])(
    "returns a fork errno when the remote child stops before restore: %s",
    async (failure) => {
      const fixture = childBashFixture({
        args: ["bash", "-c", 'printf "before|"; value=$(printf child); printf "after:%s" "$?"'],
      });
      const runFork = vi.fn(async () => {
        if (failure === "reject")
          throw Object.assign(new Error("restore transport lost"), { code: "ENOMEM" });
        return { exitCode: 0, signal: 9, coreDumped: false };
      });
      const owner = createKernelBashHost({
        context: fixture.context,
        credentials: bashCredentials,
        runFork,
      });
      const remoteComplete = vi.fn();
      let abandoned: KernelBashForkSource | undefined;
      const port: KernelBashPort = {
        ...owner.port,
        async fork() {
          const child = await owner.port.fork();
          if (child.kind === "error") return child;
          return {
            ...child,
            port: {
              ...child.port,
              async complete(result) {
                remoteComplete(result);
                await child.port.complete(result);
              },
            },
          };
        },
      };
      const reactor = createChildBash({
        module: module!,
        credentials: bashCredentials,
        pid: owner.pid,
        port,
        args: fixture.context.args,
        env: fixture.context.env,
        residentWasmBudgetBytes: 0,
        createForkSource(source) {
          abandoned = source;
          return source;
        },
      });
      try {
        // Bash itself exits 254 on a noninteractive fork error. Match ordinary admission failure.
        const control = childBashFixture({ args: fixture.context.args });
        try {
          const reference = createChildBash({
            module: module!,
            credentials: bashCredentials,
            pid: control.owner.pid,
            port: {
              ...control.owner.port,
              fork: async () => ({ kind: "error", errno: failure === "reject" ? 48 : 29 }),
            },
            args: control.context.args,
            env: control.context.env,
          });
          const expected = await reference.run();
          await reference.drain();
          await expect(reactor.run()).resolves.toEqual(expected);
          await expect(owner.exited).resolves.toEqual(expected);
          expect(fixture.stdout()).toBe(control.stdout());
          expect(fixture.stderr()).toBe(control.stderr());
        } finally {
          await control.close();
        }
        await reactor.drain();
        expect(runFork).toHaveBeenCalledOnce();
        expect(remoteComplete).not.toHaveBeenCalled();
        await expect(abandoned!.read(0, 1)).rejects.toThrow("already been restored");
        expect(fixture.stdout()).toBe("before|");
        expect(fixture.stderr()).toContain("fork:");
        expect(fixture.stderr()).not.toContain("restore transport");
        expect(fixture.processes.size).toBe(1);
        expect(fixture.wakes.size).toBe(0);
      } finally {
        await owner.close();
        await fixture.close();
      }
    },
  );
});
