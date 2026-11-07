import { expect, it, vi } from "vite-plus/test";
import { qualifyUgrepCommand } from "../UgrepCommand.ts";
import { commandGatewayFixture, emptyChild, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = (argv: readonly string[]) => ({
  executable: "/usr/local/bin/claude",
  argv,
  cwd: "/workspace",
  env: {},
});

it.each([
  ["-m", "1", "needle"],
  ["-m1", "needle"],
  ["--max-count=1", "needle"],
  ["-o", "needle"],
  ["-c", "needle"],
  ["-h", "needle", "one", "two"],
  ["-H", "needle", "file"],
  ["-w", "needle"],
  ["-x", "needle"],
  ["-qs", "needle"],
  ["-s", "needle", "file"],
  ["-F", "literal.*"],
  ["-e", "first", "-e", "second", "file"],
  ["-e", ""],
  ["-B", "2", "needle"],
  ["-B2", "needle"],
  ["-C", "2", "needle"],
  ["-C2", "needle"],
  ["-A", "2", "needle"],
  ["--include=*.md", "needle", "file.md"],
  ["--exclude=*.log", "needle", "file.md"],
  ["--color=never", "needle"],
  ["-nFwhs", "literal.*", "file"],
  ["-rinm1", "needle", "tree"],
  ["-nB2", "needle"],
  ["-inefirst", "-e", "second", "file"],
  ["-n", "-i", "a\\|b", "file"],
  ["-E", "^\\s+I:|Peak:", "file"],
])("qualifies GNU-compatible grep options %j", (...args) => {
  expect(qualifyUgrepCommand({ ...command(["grep", ...args]), executable: "/bin/grep" })).toEqual({
    kind: "qualified-isolate",
  });
});

it.each([
  ["-P", "needle"],
  ["-co", "needle"],
  ["-ov", "needle"],
  ["-oA1", "needle"],
  ["-o", "-B", "1", "needle"],
  ["-oC1", "needle"],
  ["-m0", "needle"],
  ["--max-count=0", "needle"],
  ["-m1,2", "needle"],
  ["-m", "needle"],
  ["-B101", "needle"],
  ["-e"],
  ["-EF", "needle"],
  ["-hH", "needle"],
  ["--include=*.md", "--exclude=*.md", "needle", "file.md"],
  ["--include=tree/*.md", "needle", "tree/file.md"],
  ["--exclude=**.md", "needle", "file.md"],
  ["--color=always", "needle"],
  ["-q", "needle"],
  ["-q", "needle", "missing", "file"],
  ["-G", "\\(a\\)\\1", "file"],
  ["\\d", "file"],
])("keeps differing or unqualified grep semantics on the machine %j", (...args) => {
  expect(
    qualifyUgrepCommand({ ...command(["grep", ...args]), executable: "/bin/grep" }),
  ).toMatchObject({
    kind: "machine",
    reason: expect.stringMatching(/^(incompatible-option|unqualified-option|unqualified-script)$/),
  });
});

it.each([
  ["claude", "--version"],
  ["ugrep", "--filter=external", "pattern"],
  ["ugrep", "--pager", "pattern"],
  ["ugrep", "--config", "pattern"],
  ["ugrep", "-Q", "pattern"],
  ["ugrep", "-z", "pattern"],
  ["ugrep", "-J2", "pattern"],
  ["ugrep", "-F", "literal"],
  ["ugrep", "-E", "pattern", "file.txt"],
  ["ugrep", "-A101", "pattern"],
  ["ugrep", "-E"],
])("forwards unsupported multicall or ugrep mode %j unchanged", async (...argv) => {
  const input = command(argv);
  const fixture = commandGatewayFixture({
    run: async () => {
      throw new Error("An unsupported ugrep command reached the isolate");
    },
  });
  try {
    const child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
    await child.exited;
    await child.dispose();
    expect(fixture.machineSpawn).toHaveBeenCalledOnce();
    expect(fixture.machineSpawn.mock.calls[0]![0]).toEqual(input);
  } finally {
    await fixture.close();
  }
});

it("lets the genuine matcher diagnose invalid regex syntax", () => {
  expect(qualifyUgrepCommand(command(["ugrep", "-E", "["]))).toEqual({ kind: "qualified-isolate" });
});

it("does not classify an unrelated executable", () => {
  expect(
    qualifyUgrepCommand({ ...command(["ugrep", "-E", "pattern"]), executable: "/bin/other" }),
  ).toBeUndefined();
});

it("keeps mixed recursive roots in the isolate and adapts each root's path labels", async () => {
  const input = {
    executable: "/bin/grep",
    argv: ["grep", "-rn", "needle", ".", "other.txt"],
    cwd: "/workspace",
    env: {},
  } as const;
  const originalArgv = [...input.argv];
  expect(qualifyUgrepCommand(input)).toMatchObject({ kind: "qualified-isolate" });

  const dispatched: string[][] = [];
  const fixture = commandGatewayFixture({
    run: async (childInput, invocation) => {
      dispatched.push([...childInput.command.argv]);
      invocation.acknowledge();
      return exited();
    },
  });
  let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
  try {
    child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
    await expect(child.exited).resolves.toEqual(exited());
    expect(dispatched).toEqual([
      ["grep", "--jobs=1", "--format=./%F%N%O%~", "-H", "-rn", "needle", "."],
      ["grep", "--jobs=1", "-H", "-rn", "needle", "other.txt"],
    ]);
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
    expect(input.argv).toEqual(originalArgv);
  } finally {
    if (child !== undefined) await child.dispose();
    await fixture.close();
  }
});

it("forwards grep modes outside the isolate subset through the machine gateway", async () => {
  const input = {
    executable: "/bin/grep",
    argv: ["grep", "-P", "needle", "anon-search/input.txt"],
    cwd: "/workspace",
    env: { LC_ALL: "C" },
  } as const;
  const stdoutSentinel = new TextEncoder().encode("machine grep stdout sentinel\n");
  const stderrSentinel = new TextEncoder().encode("machine grep stderr sentinel\n");
  let localDispatches = 0;
  const fixture = commandGatewayFixture({
    run: async (_childInput, invocation) => {
      localDispatches++;
      invocation.acknowledge();
      return exited(99);
    },
  });
  fixture.machineSpawn.mockImplementationOnce(async () =>
    emptyChild({
      stdout: stdoutSentinel,
      stderr: stderrSentinel,
      exited: Promise.resolve(exited(27)),
    }),
  );
  let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
  try {
    expect(qualifyUgrepCommand(input)).toMatchObject({ kind: "machine" });
    child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
    const [stdout, stderr, status] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ]);
    expect(fixture.machineSpawn).toHaveBeenCalledOnce();
    expect(fixture.machineSpawn.mock.calls[0]?.[0]).toEqual(input);
    expect(localDispatches).toBe(0);
    expect(new TextDecoder().decode(stdout)).toBe("machine grep stdout sentinel\n");
    expect(new TextDecoder().decode(stderr)).toBe("machine grep stderr sentinel\n");
    expect(status).toEqual(exited(27));
  } finally {
    if (child !== undefined) await child.dispose();
    await fixture.close();
  }
});
