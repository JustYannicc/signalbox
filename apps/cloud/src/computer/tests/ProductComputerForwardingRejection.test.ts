// @effect-diagnostics globalTimers:off - The deadline detects the pre-fix hang and never drives the green path.
import { describe, expect, it, vi } from "vite-plus/test";
import {
  KernelForwardingUnavailable,
  type KernelCommand,
} from "../../kernel/KernelCommandForwarder.ts";
import { machineInventoryFixture } from "../machineInventoryTesting.ts";
import {
  CODEX_UNIFIED_EXEC_ENV,
  createCodexLocaleProductComputer,
  loadCodexLocalePrograms,
} from "./CodexLocaleProductComputerFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const programs = loadCodexLocalePrograms();
const executable = "/usr/bin/signalbox-forwarding-rejection-probe";
const deadlineMs = 1_000;

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

describe.skipIf(programs === undefined)("ProductComputer forwarding rejection", () => {
  it("fails one machine exec promptly and resumes the real login Bash shell", async () => {
    if (programs === undefined) throw new Error("Pinned Codex locale programs are unavailable");
    const spawn = vi.fn(async (_command: KernelCommand, _signal: AbortSignal) => {
      throw new KernelForwardingUnavailable("RUNNER_NOT_READY", "No machine is attached");
    });
    const fixture = createCodexLocaleProductComputer(programs, {
      machine: { spawn },
      machineInventory: machineInventoryFixture([
        { path: executable, mode: 0o755, uid: 0, gid: 0 },
      ]),
    });
    const controller = new AbortController();
    let child: Awaited<ReturnType<typeof fixture.computer.exec>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    const operation = (async () => {
      child = await fixture.computer.exec(
        {
          executable: "/bin/bash",
          argv: [
            "bash",
            "-lc",
            `${executable}\nstatus=$?\nprintf 'continued:%s\\n' "$status"\nexit "$status"`,
          ],
          cwd: "/workspace",
          env: { ...CODEX_UNIFIED_EXEC_ENV, PATH: "/usr/bin" },
        },
        controller.signal,
        undefined,
      );
      const writer = child.stdin.getWriter();
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
      const [stdout, stderr, status] = await Promise.all([
        readText(child.stdout),
        readText(child.stderr),
        child.exited,
      ]);
      return { stdout, stderr, status, durationMs: performance.now() - started };
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Login Bash did not finish before the forwarding deadline"));
        reject(new Error(`Login Bash exceeded ${deadlineMs} ms`));
      }, deadlineMs);
    });

    try {
      const result = await Promise.race([operation, deadline]);
      expect(result.durationMs).toBeLessThan(deadlineMs);
      expect(result.status).toMatchObject({ exitCode: 126, signal: 0 });
      const continuation = result.stdout.match(/^continued:(\d+)\n$/);
      expect(continuation).not.toBeNull();
      expect(Number(continuation?.[1])).toBe(result.status.exitCode);
      expect(result.stderr).toBe("signalbox: machine unavailable (RUNNER_NOT_READY)\n");
      expect(result.stderr.length).toBeLessThanOrEqual(256);
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          executable,
          argv: [executable],
          cwd: "/workspace",
          env: expect.objectContaining({ PATH: "/usr/bin" }),
        }),
        expect.any(AbortSignal),
      );
      await child?.dispose();
      child = undefined;
      expect(fixture.computer.processes.size).toBe(0);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        await child?.dispose();
      } finally {
        await fixture.close();
        await operation.catch(() => undefined);
      }
    }
  });
});
