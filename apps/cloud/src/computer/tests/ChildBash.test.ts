// @effect-diagnostics nodeBuiltinImport:off - reads only the locally prepared, hash-pinned WASM test artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT, createKernelBashProgram } from "../../kernel/KernelBashProgram.ts";
import { createChildBash } from "../ChildBash.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelSyscallRequest } from "../../kernel/KernelSyscallPort.ts";
import { bashCredentials, childBashFixture, exited, text } from "./ChildBashFixture.ts";
import { childBashLifetimeFixture } from "./ChildBashLifetimeFixture.ts";

// The pinned third-party artifact is prepared locally; it is never committed as test data.
const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1") {
  throw new Error(`Required GNU Bash test artifact is missing: ${artifact.pathname}`);
}
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("GNU Bash test artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

function bridge(fixture: ReturnType<typeof childBashFixture>, port = fixture.owner.port) {
  return createChildBash({
    module,
    credentials: bashCredentials,
    pid: fixture.owner.pid,
    port,
    args: fixture.context.args,
    env: fixture.context.env,
  });
}

describe.skipIf(!available)("actual pinned GNU Bash child bridge", () => {
  it("reports root exit while a background child retains the worker and its descriptors", async () => {
    const control = childBashLifetimeFixture(module, false);
    const fixture = childBashLifetimeFixture(module);
    try {
      const expected = control.start("/bin/blocked & exit 17");
      await control.entered;
      expect(await expected.exited).toMatchObject({ status: "ok", value: exited(17) });
      const command = fixture.start("/bin/blocked & exit 17");
      const background = await fixture.entered;
      expect(await command.exited).toMatchObject({ status: "ok", value: exited(17) });
      expect(fixture.capacity.active).toBe(1);
      expect(fixture.rootContext().filesystem.descriptors.has(1)).toBe(false);
      expect(background.filesystem.descriptors.has(1)).toBe(true);
      expect(background.signal.aborted).toBe(false);
      const drained = fixture.capacity
        .acquire(new AbortController().signal)
        .then((permit) => permit.release());
      fixture.release();
      await drained;
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.files.stdout()).toBe("background output");
      expect(await command.exited).toMatchObject({ status: "ok", value: exited(17) });
    } finally {
      await fixture.close();
      await control.close();
    }
  });

  it("holds the background worker until explicit close after publishing the root's exit", async () => {
    const fixture = childBashLifetimeFixture(module);
    try {
      const command = fixture.start("/bin/blocked & exit 17");
      await fixture.entered;
      expect(await command.exited).toMatchObject({ status: "ok", value: exited(17) });
      expect(fixture.capacity.active).toBe(1);
      const drained = fixture.capacity
        .acquire(new AbortController().signal)
        .then((permit) => permit.release());
      await fixture.closeWorker();
      await fixture.aborted;
      await drained;
      expect(fixture.capacity.active).toBe(0);
      expect(await command.exited).toMatchObject({ status: "ok", value: exited(17) });
    } finally {
      await fixture.close();
    }
  });

  it("signals the retained background identity after the root is reaped and keeps its exit result", async () => {
    const fixture = childBashLifetimeFixture(module);
    try {
      const command = fixture.start("/bin/blocked & exit 17");
      const background = await fixture.entered;
      expect(await command.exited).toMatchObject({ status: "ok", value: exited(17) });
      expect(fixture.programs.reap(command.handle).status).toBe("ok");
      expect(fixture.programs.processes.info(background.identity.handle)).toMatchObject({
        status: "ok",
        value: { parentPid: 1 },
      });
      expect(fixture.capacity.active).toBe(1);
      const drained = fixture.capacity
        .acquire(new AbortController().signal)
        .then((permit) => permit.release());
      expect(fixture.programs.processes.signal(background.identity.handle, 9).status).toBe("ok");
      await fixture.aborted;
      await drained;
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.files.stdout()).toBe("");
      expect(await command.exited).toMatchObject({ status: "ok", value: exited(17) });
    } finally {
      await fixture.close();
    }
  });

  it("preserves a successful root result after Bash handles a fork's execution failure", async () => {
    const control = childBashLifetimeFixture(module, false);
    const fixture = childBashLifetimeFixture(module);
    try {
      const script = '/bin/broken; printf "recovered:%s" "$?"';
      expect(await control.start(script).exited).toMatchObject({ status: "ok", value: exited() });
      expect(await fixture.start(script).exited).toMatchObject({ status: "ok", value: exited() });
      expect(control.files.stdout()).toBe("recovered:0");
      expect(fixture.files.stdout()).toBe(control.files.stdout());
    } finally {
      await fixture.close();
      await control.close();
    }
  });

  it("preserves caller argv0, cwd, environment, PID, split streams and live filesystem writes", async () => {
    const fixture = childBashFixture({
      args: [
        "caller-label",
        "--noprofile",
        "--norc",
        "-c",
        'printf "%s|%s|%s|%s|%s" "$0" "$PWD" "$TOKEN" "$$" "$UID"; printf "error" >&2; printf "saved" > out; cd nested; printf "inside" > aftercd; pwd',
      ],
    });
    const requests: KernelSyscallRequest[] = [];
    const port: KernelBashPort = {
      ...fixture.owner.port,
      async call(request) {
        requests.push(request);
        return fixture.owner.port.call(structuredClone(request));
      },
    };
    try {
      expect(await bridge(fixture, port).run()).toEqual(exited());
      expect(fixture.stdout()).toBe(
        `caller-label|/workspace|雪|${fixture.owner.pid}|1000/workspace/nested\n`,
      );
      expect(fixture.stderr()).toBe("error");
      expect(fixture.read("/workspace/out")).toBe("saved");
      expect(fixture.read("/workspace/nested/aftercd")).toBe("inside");
      expect(requests.some((request) => request.name === "fd_write")).toBe(true);
      expect(
        Math.max(
          ...requests.map((request) =>
            request.regions.reduce((sum, region) => sum + region.bytes.length, 0),
          ),
        ),
      ).toBeLessThan(128 * 1024);
    } finally {
      await fixture.close();
    }
  });

  it("keeps fork heaps and captures separate through nested substitution, pipeline and wait status", async () => {
    const fixture = childBashFixture({
      args: [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        'x=parent; f() { local v=outer; printf "%s" "$(v=child; printf "%s:%s" "$v" "$(printf nested)")"; }; f; printf ":%s|" "$x"; printf "pipe\\n" | { read -r v; printf "<%s>" "$v"; }; (exit 7); printf ":%s" "$?"',
      ],
    });
    try {
      expect(await bridge(fixture).run()).toEqual(exited());
      expect(fixture.stdout()).toBe("child:nested:parent|<pipe>:7");
      expect(fixture.stderr()).toBe("");
      expect(fixture.processes.size).toBe(1);
      expect(fixture.wakes.size).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("preserves redirected preopens and applies umask to the facet's filesystem", async () => {
    const fixture = childBashFixture({
      args: [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        'umask 077; exec 3> log; printf "ok" >&3; printf "next" > created; printf "%s" "$(cd nested; pwd)"; exec 3>&-',
      ],
    });
    try {
      expect(await bridge(fixture).run()).toEqual(exited());
      expect(fixture.read("/workspace/log")).toBe("ok");
      expect(fixture.read("/workspace/created")).toBe("next");
      expect(fixture.filesystem.getPosixMetadata("created").mode & 0o777).toBe(0o600);
      expect(fixture.stdout()).toBe("/workspace/nested");
      expect(fixture.filesystem.cwd).toBe("/workspace");
      expect(fixture.stderr()).toBe("");
    } finally {
      await fixture.close();
    }
  });

  it("executes through the same facet identity and exact replacement arguments and environment", async () => {
    const requests: unknown[] = [];
    const fixture = childBashFixture({
      args: [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        'export ADDED="a b"; exec /bin/external "hello world"',
      ],
      exec: async (request) => {
        requests.push(request);
        request.filesystem.write(1, text("replacement"), null);
        return exited(23);
      },
    });
    fixture.write("/bin/external", "", 0o755);
    try {
      expect(await bridge(fixture).run()).toEqual(exited(23));
      expect(fixture.stdout()).toBe("replacement");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: "/bin/external",
        args: ["/bin/external", "hello world"],
        identity: fixture.context.identity,
        filesystem: fixture.filesystem,
        env: { ADDED: "a b", TOKEN: "雪" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("resumes Bash after exec admission fails", async () => {
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "-c", '/bin/external; printf "after:%s" "$?"'],
    });
    fixture.write("/bin/external", "", 0o755);
    try {
      expect(await bridge(fixture).run()).toEqual(exited());
      expect(fixture.stdout()).toBe("after:127");
      expect(fixture.stderr()).toContain("/bin/external");
    } finally {
      await fixture.close();
    }
  });

  it("keeps the existing same-isolate Bash runtime working after the shared continuation split", async () => {
    const fixture = childBashFixture({
      args: [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        'printf "%s" "$(printf local)"; (exit 9); printf ":%s" "$?"',
      ],
    });
    try {
      const program = createKernelBashProgram({ module, credentials: bashCredentials });
      expect(await program.run(fixture.context)).toEqual(exited());
      expect(fixture.stdout()).toBe("local:9");
      expect(fixture.stderr()).toBe("");
    } finally {
      await fixture.close();
    }
  });
});
