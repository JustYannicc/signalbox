// @effect-diagnostics nodeBuiltinImport:off - reads the locally prepared, hash-pinned WASM test artifact.
// @effect-diagnostics globalTimers:off - deadlines fail stalled guests; descriptor milestones establish progress.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { kernelPayloadBudget, type KernelPayloadWindow } from "../../kernel/KernelPayloadBudget.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const artifactBytes = NodeFS.readFileSync(artifact);
if (
  artifactBytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
  NodeCrypto.createHash("sha256").update(artifactBytes).digest("hex") !==
    KERNEL_BASH_ARTIFACT.sha256
)
  throw new Error("GNU Bash test artifact does not match its pin");
const module = new WebAssembly.Module(artifactBytes);

const bashArgs = (script: string) => ["bash", "--noprofile", "--norc", "-c", script];

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

async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline" }), milliseconds);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "completed" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function padding(bytes: number) {
  const line = `# ${"x".repeat(61)}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

async function holdWindows(count: number) {
  const signal = new AbortController().signal;
  const windows: KernelPayloadWindow[] = [];
  try {
    for (let index = 0; index < count; index++)
      windows.push(await kernelPayloadBudget.open(signal));
  } catch (error) {
    for (const window of windows) window.release();
    throw error;
  }
  return () => {
    for (const window of windows) window.release();
  };
}

function observePipeIo(
  port: KernelBashPort,
  onRead: () => void,
  onFork: () => void,
): KernelBashPort {
  const observe = (request: {
    readonly name: string;
    readonly args: readonly (number | bigint)[];
  }) => {
    if (request.name === "fd_read" && Number(request.args[0]) === 0) onRead();
  };
  return {
    ...port,
    call(request) {
      observe(request);
      return port.call(request);
    },
    callBash(request) {
      observe(request);
      return port.callBash(request);
    },
    async fork() {
      const child = await port.fork();
      if (child.kind === "fork") onFork();
      return child.kind === "fork"
        ? { ...child, port: observePipeIo(child.port, onRead, onFork) }
        : child;
    },
  };
}

function trackOpenCredits() {
  let outstanding = 0;
  const open = kernelPayloadBudget.open.bind(kernelPayloadBudget);
  const spy = vi.spyOn(kernelPayloadBudget, "open").mockImplementation(async (...args) => {
    const window = await open(...args);
    outstanding++;
    let released = false;
    return {
      get bytes() {
        return window.bytes;
      },
      release() {
        if (released) return;
        released = true;
        outstanding--;
        window.release();
      },
    };
  });
  return {
    outstanding: () => outstanding,
    restore: () => spy.mockRestore(),
  };
}

describe("pinned GNU Bash child payload budgets", () => {
  it("sources a complete 1.5 MiB script", async () => {
    const fixture = childBashFixture({
      args: bashArgs("source ./big.sh; echo AFTER"),
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    });
    try {
      fixture.write("/workspace/big.sh", `${padding(1536 * 1024)}echo END\n`);
      const result = await within(bridge(fixture).run(), 30_000);
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") expect(result.value).toEqual(exited());
      expect(fixture.stdout()).toBe("END\nAFTER\n");
    } finally {
      fixture.controller.abort();
      await fixture.close();
    }
  }, 60_000);

  it("sources a 200 KiB script while 100 other payload windows remain held", async () => {
    const fixture = childBashFixture({
      args: bashArgs("source ./mid.sh; echo AFTER"),
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    });
    let release: (() => void) | undefined;
    try {
      fixture.write("/workspace/mid.sh", `${padding(200 * 1024)}echo END\n`);
      release = await holdWindows(100);
      const result = await within(bridge(fixture).run(), 30_000);
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") expect(result.value).toEqual(exited());
      expect(fixture.stdout()).toBe("END\nAFTER\n");
    } finally {
      fixture.controller.abort();
      release?.();
      await fixture.close();
    }
  }, 60_000);

  it("feeds a complete 1.5 MiB here-document to mapfile", async () => {
    const body = padding(1536 * 1024);
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "./heredoc.sh"],
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    });
    try {
      fixture.write(
        "/workspace/heredoc.sh",
        `mapfile -t lines <<'EOF'\n${body}EOF\nprintf 'rc=%s n=%s\\n' "$?" "\${#lines[@]}"\n`,
      );
      const result = await within(bridge(fixture).run(), 30_000);
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") expect(result.value).toEqual(exited());
      expect(fixture.stdout()).toBe(`rc=0 n=${body.split("\n").length - 1}\n`);
    } finally {
      fixture.controller.abort();
      await fixture.close();
    }
  }, 60_000);

  it.each([100, 160])(
    "finishes %i pipe readers that command-substitute after each read",
    async (jobs) => {
      const script = `coproc FEED { while read -r l; do echo "$l"; done; }; exec 5<&\${FEED[0]} 6>&\${FEED[1]}; for i in {1..${jobs}}; do ( read -r x <&5; y=$(echo "$x"); : "$y" ) & done; echo forked >&2; for i in {1..${jobs}}; do echo $i; done >&6; exec 6>&- 5<&-; eval "exec \${FEED[1]}>&-"; wait; echo done`;
      const fixture = childBashFixture({
        args: bashArgs(script),
        env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
      });
      try {
        const result = await within(bridge(fixture).run(), 15_000);
        expect(result.kind, `Bash did not finish; stderr: ${fixture.stderr().slice(-200)}`).toBe(
          "completed",
        );
        if (result.kind === "completed") expect(result.value).toEqual(exited());
        expect(fixture.stderr()).toContain("forked\n");
        expect(fixture.stdout()).toBe("done\n");
      } finally {
        fixture.controller.abort();
        await fixture.close();
      }
    },
    30_000,
  );

  it("releases all reader credits on close so the next command can fork", async () => {
    const credits = trackOpenCredits();
    const fixture = childBashFixture({
      args: bashArgs(
        "coproc F { read -r z; }; exec 5<&${F[0]}; for i in {1..60}; do ( read -r x <&5 ) & done; wait",
      ),
      env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
    });
    const readersEntered = Promise.withResolvers<number>();
    let observedReaders = 0;
    let forkedProcesses = 0;
    let closed = false;
    try {
      const running = bridge(
        fixture,
        observePipeIo(
          fixture.owner.port,
          () => {
            observedReaders++;
            if (observedReaders === 61) readersEntered.resolve(observedReaders);
          },
          () => {
            forkedProcesses++;
          },
        ),
      ).run();
      const progress = await within(
        Promise.race([
          readersEntered.promise,
          running.then(
            () => -1,
            () => -1,
          ),
        ]),
        15_000,
      );
      expect(
        progress.kind,
        `Only ${observedReaders} fd-0 reads entered across ${forkedProcesses} forks; ${credits.outstanding()} open credits remain`,
      ).toBe("completed");
      if (progress.kind === "completed") expect(progress.value).toBe(61);

      fixture.controller.abort();
      await fixture.close();
      closed = true;
      const commandSettled = await within(
        running.then(
          () => undefined,
          () => undefined,
        ),
        10_000,
      );
      expect(commandSettled.kind).toBe("completed");
      const outstandingAfterClose = credits.outstanding();

      const following = childBashFixture({
        args: bashArgs('value=$(echo following); echo "forked:$value"'),
        env: { HOME: "/workspace", PATH: "/bin", TMPDIR: "/workspace" },
      });
      try {
        const result = await within(bridge(following).run(), 15_000);
        expect(result.kind).toBe("completed");
        if (result.kind === "completed") expect(result.value).toEqual(exited());
        expect(following.stdout()).toBe("forked:following\n");
      } finally {
        following.controller.abort();
        await following.close();
      }
      expect(outstandingAfterClose).toBe(0);
      expect(credits.outstanding()).toBe(0);
    } finally {
      if (!closed) {
        fixture.controller.abort();
        await fixture.close();
      }
      credits.restore();
    }
  }, 60_000);
});
