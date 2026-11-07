// @effect-diagnostics nodeBuiltinImport:off - reads only the pinned Ugrep WASM artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { commandGatewayFixture, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

import { capturedGrepCases as cases, grepInputLines as lines } from "./GrepStdinFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = (args: readonly string[]) => ({
  executable: "/usr/bin/grep",
  argv: ["grep", ...args],
  cwd: "/work",
  env: { LC_ALL: "C" },
});

const artifact =
  NodeProcess.env.SIGNALBOX_UGREP_ARTIFACT ??
  new URL("../../../../../.t3/1071/programs/ugrep.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_UGREP_ARTIFACT === "1")
  throw new Error("The grep catalog test requires the pinned Ugrep WASI artifact");
let module: WebAssembly.Module;
if (available) {
  const bytes = NodeFS.readFileSync(artifact);
  if (
    bytes.length !== KERNEL_UGREP_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_UGREP_ARTIFACT.sha256
  )
    throw new Error("The Ugrep catalog artifact does not match its pin");
  module = new WebAssembly.Module(bytes);
}

describe.skipIf(!available)("pinned Ugrep grep through the public command gateway", () => {
  async function run(
    args: readonly string[],
    source: "stdin" | "file" = "stdin",
    input = lines.join("\n") + "\n",
    expectedInvocations?: readonly (readonly string[])[],
  ) {
    const dispatched: { executable: string; argv: readonly string[] }[] = [];
    const fixture = commandGatewayFixture({
      run: async (input, invocation) => {
        dispatched.push({ executable: input.command.executable, argv: input.command.argv });
        try {
          return await createChildBusybox({
            module,
            port: await invocation.host<KernelBusyboxPort>(),
            args: input.command.argv,
            env: input.command.env,
          }).run();
        } finally {
          invocation.acknowledge();
        }
      },
    });
    fixture.filesystem.mkdir("/work");
    try {
      fixture.write("/work/input", input);
      const captured = command(source === "file" ? [...args, "input"] : args);
      const child = await fixture.gateway.exec(captured, fixture.controller.signal, undefined);
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          readAll(child.stdout),
          readAll(child.stderr),
          (async () => {
            const writer = child.stdin.getWriter();
            try {
              const bytes = new TextEncoder().encode(source === "stdin" ? input : "");
              const split = Math.max(1, bytes.indexOf(0xe9) + 1);
              await writer.write(bytes.subarray(0, split));
              await writer.write(bytes.subarray(split));
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          })(),
        ]);
        await fixture.gateway.drain();
        expect(fixture.machineSpawn).not.toHaveBeenCalled();
        expect(dispatched).toEqual(
          (expectedInvocations ?? [["grep", "--jobs=1", ...captured.argv.slice(1)]]).map(
            (argv) => ({
              executable: "/bin/grep",
              argv,
            }),
          ),
        );
        expect(fixture.capacity.active).toBe(0);
        return {
          status,
          stdout: new TextDecoder().decode(stdout),
          stderr: new TextDecoder().decode(stderr),
        };
      } finally {
        await child.dispose();
      }
    } finally {
      await fixture.close();
    }
  }

  it.each(cases)("runs $name without a machine", async ({ args, expected }) => {
    const result = await run(args);
    expect(result).toEqual({ status: exited(), stdout: expected, stderr: "" });
  });

  it.each([
    {
      args: ["-m1", "^- State:"],
      source: "file" as const,
      input: "heading\n- State: Ready\n- State: Working\n",
      expected: "- State: Ready\n",
    },
    {
      args: ["-o", "\\[[^]]*\\]"],
      source: "stdin" as const,
      input: "before [Ready] between [Working]\n[Done] after\n",
      expected: "[Ready]\n[Working]\n[Done]\n",
    },
    {
      args: ["-n", "-i", "a\\|b"],
      source: "file" as const,
      input: "zzz\nAlpha\nBETA\nccc\n",
      expected: "2:Alpha\n3:BETA\n",
    },
  ])(
    "runs the real Claude invocation $args with GNU output",
    async ({ args, source, input, expected }) => {
      expect(await run(args, source, input)).toEqual({
        status: exited(),
        stdout: expected,
        stderr: "",
      });
    },
  );

  it.each(cases.filter(({ args }) => args[0]?.includes("E")))(
    "runs $name against a file",
    async ({ args, expected }) => {
      expect(await run(args, "file")).toEqual({ status: exited(), stdout: expected, stderr: "" });
    },
  );

  it.each([
    { args: ["-m", "1", "needle"], stdout: "needle needle\n" },
    { args: ["--max-count=1", "needle"], stdout: "needle needle\n" },
    { args: ["-c", "needle"], stdout: "3\n" },
    { args: ["-h", "needle"], stdout: "needle needle\nwordneedle\nneedle\n" },
    { args: ["-H", "needle"], stdout: "input:needle needle\ninput:wordneedle\ninput:needle\n" },
    { args: ["-w", "needle"], stdout: "needle needle\nneedle\n" },
    { args: ["-x", "needle"], stdout: "needle\n" },
    { args: ["-qs", "needle"], stdout: "" },
    { args: ["-s", "needle"], stdout: "needle needle\nwordneedle\nneedle\n" },
    { args: ["-F", "needle needle"], stdout: "needle needle\n" },
    { args: ["-e", "needle", "-e", "quiet"], stdout: "needle needle\nwordneedle\nneedle\nquiet\n" },
    { args: ["-B", "1", "^needle$"], stdout: "wordneedle\nneedle\n" },
    { args: ["-C1", "^needle$"], stdout: "wordneedle\nneedle\nquiet\n" },
    { args: ["--include=input", "needle"], stdout: "needle needle\nwordneedle\nneedle\n" },
    { args: ["--exclude=input", "needle"], stdout: "", exitCode: 1 },
    { args: ["--color=never", "needle"], stdout: "needle needle\nwordneedle\nneedle\n" },
    { args: ["-nwhsF", "needle"], stdout: "1:needle needle\n3:needle\n" },
  ])("preserves GNU output for $args", async ({ args, stdout, exitCode = 0 }) => {
    expect(await run(args, "file", "needle needle\nwordneedle\nneedle\nquiet\n")).toEqual({
      status: exited(exitCode),
      stdout,
      stderr: "",
    });
  });

  it.each(["-s", "-qs"])("preserves GNU missing-file status with %s", async (option) => {
    expect(await run([option, "needle", "missing"], "stdin", "")).toEqual({
      status: exited(2),
      stdout: "",
      stderr: "",
    });
  });

  it.each([
    { args: ["-rc", "needle", "."], format: "--format=./%F%m%~", stdout: "./input:3\n" },
    {
      args: ["-rno", "needle", "."],
      format: "--format=./%F%N%o%~",
      stdout: "./input:1:needle\n./input:1:needle\n./input:2:needle\n./input:3:needle\n",
    },
    { args: ["-rlh", "needle", "."], format: "--format=./%f%~", stdout: "./input\n" },
  ])("keeps GNU dot-root labels for $args", async ({ args, format, stdout }) => {
    expect(
      await run(args, "stdin", "needle needle\nwordneedle\nneedle\nquiet\n", [
        ["grep", "--jobs=1", format, ...args],
      ]),
    ).toEqual({ status: exited(), stdout, stderr: "" });
  });

  it("keeps repeated -e patterns and -m values out of mixed recursive roots", async () => {
    const args = ["-rnm", "1", "-e", "needle", "-e", "quiet"];
    const stdout = "./input:1:needle needle\ninput:1:needle needle\n";
    expect(
      await run([...args, ".", "input"], "stdin", "needle needle\nquiet\n", [
        ["grep", "--jobs=1", "--format=./%F%N%O%~", "-H", ...args, "."],
        ["grep", "--jobs=1", "-H", ...args, "input"],
      ]),
    ).toEqual({ status: exited(), stdout, stderr: "" });
  });

  it("returns status 1 for empty stdin", async () => {
    expect(await run(["needle"], "stdin", "")).toEqual({
      status: exited(1),
      stdout: "",
      stderr: "",
    });
  });

  it("returns status 1 for no matches", async () => {
    expect(await run(["-E", "does-not-match-any-line"])).toEqual({
      status: exited(1),
      stdout: "",
      stderr: "",
    });
  });
});
