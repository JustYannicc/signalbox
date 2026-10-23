// @effect-diagnostics nodeBuiltinImport:off - reads the locally prepared, hash-pinned WASM test artifact.
// @effect-diagnostics globalTimers:off - deadlines fail stalled guests; descriptor milestones establish progress.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

// The pinned third-party artifact is prepared locally; it is never committed as test data.
const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error(`Required GNU Bash test artifact is missing: ${artifact.pathname}`);
let module: WebAssembly.Module;
if (available) {
  const artifactBytes = NodeFS.readFileSync(artifact);
  if (
    artifactBytes.length !== KERNEL_BASH_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(artifactBytes).digest("hex") !==
      KERNEL_BASH_ARTIFACT.sha256
  )
    throw new Error("GNU Bash test artifact does not match its pin");
  module = new WebAssembly.Module(artifactBytes);
}

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

describe.skipIf(!available)("pinned GNU Bash child payload transfers", () => {
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

  it("tears down cancelled pipe readers so a fresh command can fork", async () => {
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
        `Only ${observedReaders} fd-0 reads entered across ${forkedProcesses} forks`,
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
    } finally {
      if (!closed) {
        fixture.controller.abort();
        await fixture.close();
      }
    }
  }, 60_000);
});
