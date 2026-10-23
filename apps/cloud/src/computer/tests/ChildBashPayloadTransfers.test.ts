// @effect-diagnostics nodeBuiltinImport:off - reads the locally prepared, hash-pinned WASM test artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import { createChildBash } from "../ChildBash.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";
import { createBashGateway } from "./ChildBashGatewayFixture.ts";
import {
  publicCommand,
  captureText,
  captureCapacityPressure,
  gatewayTrace,
  cleanupGatewayCommand,
  withFailurePreservingCleanup,
  within,
} from "./ChildBashGatewayCommand.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

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

function padding(bytes: number) {
  const line = `# ${"x".repeat(61)}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
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
      const gateway = createBashGateway();
      const commandController = new AbortController();
      const stopPressure = captureCapacityPressure(gateway);
      let child: KernelCommandChild | undefined;
      let commandSettled = false;
      await withFailurePreservingCleanup(
        async () => {
          const command = await publicCommand(gateway, script, commandController.signal);
          child = command;
          const stdout = captureText(command.stdout);
          const stderr = captureText(command.stderr);
          const result = await within(
            Promise.all([stdout.settled, stderr.settled, command.exited]),
            15_000,
          );
          commandSettled = result.kind === "completed";
          const message =
            result.kind === "rejected"
              ? `Bash rejected: ${String(result.error)}`
              : "Bash did not finish";
          const output = `Bash stderr: ${stderr.text()}; stdout: ${stdout.text()}`;
          expect(result.kind, `${message}; ${output}; ${gatewayTrace(gateway)}`).toBe("completed");
          if (result.kind === "completed") {
            const [, , status] = result.value;
            const stdoutText = stdout.text();
            const stderrText = stderr.text();
            expect(
              status,
              `Bash stderr: ${stderrText}; stdout: ${stdoutText}; ${gatewayTrace(gateway)}`,
            ).toEqual(exited());
            expect(stderrText).toContain("forked\n");
            expect(stdoutText).toBe("done\n");
          }
        },
        async (bodyFailed) => {
          stopPressure();
          await cleanupGatewayCommand(
            gateway,
            child,
            commandController,
            bodyFailed || !commandSettled,
          );
        },
      );
    },
    30_000,
  );

  it("tears down cancelled pipe readers so a fresh command can fork", async () => {
    const gateway = createBashGateway();
    const commandController = new AbortController();
    const stopPressure = captureCapacityPressure(gateway);
    const readersEntered = Promise.withResolvers<number>();
    let observedReaders = 0;
    let activeSettled = false;
    let activeController = commandController;
    let firstExit: unknown;
    let firstFailure: unknown;
    let child: KernelCommandChild | undefined;
    const pushTrace = gateway.forkTrace.push.bind(gateway.forkTrace);
    // Count traced syscall starts so cancellation happens at a deterministic reader milestone.
    gateway.forkTrace.push = (...events) => {
      for (const event of events) {
        if (
          event.event === "syscall" &&
          event.name === "fd_read" &&
          Array.isArray(event.args) &&
          Number(event.args[0]) === 0
        ) {
          observedReaders++;
          if (observedReaders === 61) readersEntered.resolve(observedReaders);
        }
      }
      return pushTrace(...events);
    };
    await withFailurePreservingCleanup(
      async () => {
        const first = await publicCommand(
          gateway,
          "coproc F { read -r z; }; exec 5<&${F[0]}; for i in {1..60}; do ( read -r x <&5 ) & done; wait",
          commandController.signal,
        );
        child = first;
        const stdout = captureText(first.stdout);
        const stderr = captureText(first.stderr);
        void stdout.settled.catch(() => undefined);
        void stderr.settled.catch(() => undefined);
        const progress = await within(
          Promise.race([
            readersEntered.promise,
            first.exited.then(
              (status) => {
                activeSettled = true;
                firstExit = status;
                return -1;
              },
              (error: unknown) => {
                activeSettled = true;
                firstFailure = error;
                return -1;
              },
            ),
          ]),
          15_000,
        );
        const earlyStderr = stderr.text();
        const earlyExit =
          firstFailure === undefined
            ? `exit: ${JSON.stringify(firstExit)}`
            : `error: ${String(firstFailure)}`;
        expect(
          progress.kind,
          `Only ${observedReaders} fd-0 reads entered across ${gateway.forkTrace.filter((event) => event.event === "fork").length} forks; ${gatewayTrace(gateway)}`,
        ).toBe("completed");
        if (progress.kind === "completed")
          expect(
            progress.value,
            `${earlyExit}; stderr: ${earlyStderr}; stdout: ${stdout.text()}; ${gatewayTrace(gateway)}`,
          ).toBe(61);

        commandController.abort();
        const commandSettled = await within(
          first.exited.then(
            () => undefined,
            () => undefined,
          ),
          10_000,
        );
        activeSettled = commandSettled.kind === "completed";
        expect(
          commandSettled.kind,
          `Cancelled command did not settle; ${gatewayTrace(gateway)}`,
        ).toBe("completed");
        await first.dispose();
        child = undefined;
        const drained = await within(gateway.fixture.gateway.drain(), 10_000);
        const drainMessage =
          drained.kind === "rejected"
            ? `Gateway drain rejected: ${String(drained.error)}`
            : "Gateway did not drain after cancellation";
        expect(drained.kind, `${drainMessage}; ${gatewayTrace(gateway)}`).toBe("completed");

        const followingController = new AbortController();
        activeController = followingController;
        activeSettled = false;
        const following = await publicCommand(
          gateway,
          'value=$(echo following); echo "forked:$value"',
          followingController.signal,
        );
        child = following;
        const followingStdout = captureText(following.stdout);
        const followingStderr = captureText(following.stderr);
        const result = await within(
          Promise.all([followingStdout.settled, followingStderr.settled, following.exited]),
          15_000,
        );
        activeSettled = result.kind === "completed";
        const followingMessage =
          result.kind === "rejected"
            ? `Following Bash command rejected: ${String(result.error)}`
            : "Following Bash command did not finish";
        expect(result.kind, `${followingMessage}; ${gatewayTrace(gateway)}`).toBe("completed");
        if (result.kind === "completed") {
          const [, , status] = result.value;
          expect(
            status,
            `Bash stderr: ${followingStderr.text()}; ${gatewayTrace(gateway)}`,
          ).toEqual(exited());
          expect(followingStdout.text()).toBe("forked:following\n");
        }
        await following.dispose();
        child = undefined;
      },
      async (bodyFailed) => {
        stopPressure();
        await cleanupGatewayCommand(gateway, child, activeController, bodyFailed || !activeSettled);
      },
    );
  }, 60_000);
});
