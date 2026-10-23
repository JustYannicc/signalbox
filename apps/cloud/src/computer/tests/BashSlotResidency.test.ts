// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { createChildBash } from "../ChildBash.ts";
import { ChildHostLease } from "../ChildHostLease.ts";
import { createWorkerBashHost } from "../WorkerBashHost.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error("Bash slot residency requires the pinned GNU Bash artifact");

describe.skipIf(!available)("Bash slot residency", () => {
  it("reports all local fork memories through one physical slot's syscall observations", async () => {
    const bytes = NodeFS.readFileSync(artifact);
    expect(bytes.byteLength).toBe(KERNEL_BASH_ARTIFACT.bytes);
    expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
      KERNEL_BASH_ARTIFACT.sha256,
    );
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "-c", "(printf child) & wait"],
    });
    const observations: number[] = [];
    const lease = new ChildHostLease((residentBytes) => observations.push(residentBytes));
    const worker = createWorkerBashHost(
      { context: fixture.context, credentials: bashCredentials },
      lease,
    );
    const reactor = createChildBash({
      module: new WebAssembly.Module(bytes),
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: worker.host,
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      expect(await reactor.run()).toEqual(exited());
      await reactor.drain();
      expect(fixture.stdout()).toBe("child");
      expect(reactor.peakResidentWasmBytes).toBeGreaterThan(32 * 1024 * 1024);
      expect(Math.max(...observations)).toBe(reactor.peakResidentWasmBytes);
    } finally {
      lease.release();
      await worker.close();
      await fixture.close();
    }
  });
});
