import { describe, expect, it, vi } from "vite-plus/test";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";

import { commandGatewayFixture, emptyChild, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const command = (args: readonly string[]) => ({
  executable: "/bin/sed",
  argv: ["sed", ...args],
  cwd: "/workspace",
  env: { LC_ALL: "C" },
});

describe("in-place sed qualification", () => {
  it.each([
    ["-i", "s/needle/thread/g", "input"],
    ["-i.bak", "s/needle/thread/g", "input"],
    ["-i", "-e", "s/needle/thread/g", "-e", "s/thread/rope/g", "first", "second"],
    ["-i.bak", "-e", "s/needle/thread/g", "first", "second"],
    ["-i", "-E", "s/(needle) (one|two)/\\2/g", "input"],
  ])("qualifies the measured file-edit shape %j", (...args) => {
    expect(qualifyGnuCommand(command(args))).toEqual({ kind: "qualified-isolate" });
  });

  it.each([
    ["-i", "", "s/needle/thread/g", "input"],
    ["--sandbox", "-i", "s/needle/thread/g", "input"],
    ["-i*", "s/needle/thread/g", "input"],
    ["-i.bak", "s/needle/thread/g", "-"],
    ["-i", "s/a.*b/x/", "input"],
    ["-i../backup", "s/a/b/", "input"],
    ["-i", "-i.bak", "s/a/b/", "input"],
    ["-i", "-f", "edits.sed", "input"],
    ["-i", "-e", "s/a/b/", "-e", "s/b.*c/x/", "input"],
    ["-i", "-e"],
    ["-i", "s/a/b/"],
  ])("keeps unqualified semantics on the machine for %j", (...args) => {
    expect(qualifyGnuCommand(command(args)).kind).toBe("machine");
  });
});

it("runs editing sed through normal child admission and forwards unqualified backups before loading a child", async () => {
  const calls: string[][] = [];
  const fixture = commandGatewayFixture({
    run: async (input, invocation) => {
      calls.push([...input.command.argv]);
      invocation.acknowledge();
      return exited(0);
    },
  });
  fixture.write("input", "a\n");
  fixture.write("first", "a\n");
  fixture.write("second", "a\n");
  try {
    for (const args of [
      ["-i", "s/a/b/", "input"],
      ["-i.bak", "-e", "s/a/b/", "first", "second"],
      ["-i*", "s/a/b/", "input"],
    ]) {
      const child = await fixture.gateway.exec(command(args), fixture.controller.signal, undefined);
      try {
        await expect(child.exited).resolves.toEqual(exited(0));
      } finally {
        await child.dispose();
      }
    }
    await fixture.gateway.drain();
    expect(calls).toEqual([
      ["sed", "-i", "s/a/b/", "input"],
      ["sed", "-i.bak", "-e", "s/a/b/", "first", "second"],
    ]);
    expect(fixture.machineSpawn).toHaveBeenCalledOnce();
    expect(fixture.machineSpawn.mock.calls[0]?.[0]).toEqual(command(["-i*", "s/a/b/", "input"]));
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});

it("forwards nonregular or unavailable edit targets before any child starts, using the command cwd", async () => {
  const calls: string[][] = [];
  const fixture = commandGatewayFixture({
    run: async (input, invocation) => {
      calls.push([...input.command.argv]);
      invocation.acknowledge();
      return exited(0);
    },
  });
  fixture.write("input", "a\n");
  fixture.write("nested/input", "a\n");
  fixture.filesystem.symlink("/workspace/nested/input", "/workspace/nested/link");
  try {
    for (const file of ["/dev/null", "../nested", "missing", "input", "link"]) {
      const child = await fixture.gateway.exec(
        { ...command(["-i", "s/a/b/", file]), cwd: "/workspace/nested" },
        fixture.controller.signal,
        undefined,
      );
      try {
        await child.exited;
      } finally {
        await child.dispose();
      }
    }
    await fixture.gateway.drain();
    expect(calls.map((argv) => argv.at(-1))).toEqual(["input", "link"]);
    expect(fixture.machineSpawn).toHaveBeenCalledTimes(3);
    expect(fixture.read("input")).toBe("a\n");
    expect(fixture.read("nested/input")).toBe("a\n");
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});

it("forwards the whole edit when any target directory is unwritable, preserving GNU failure output", async () => {
  const local = vi.fn(async () => {
    throw new Error("Unwritable edit reached a child");
  });
  const fixture = commandGatewayFixture({ run: local });
  fixture.write("input", "a\n");
  fixture.write("nested/input", "a\n");
  fixture.filesystem.chmod("/workspace/nested", 0o555);
  const stderr = new TextEncoder().encode(
    "sed: couldn't open temporary file nested/sedABC123: Permission denied\n",
  );
  fixture.machineSpawn.mockImplementationOnce(async () =>
    emptyChild({ stderr, exited: Promise.resolve(exited(4)) }),
  );
  const input = command(["-i.bak", "s/a/b/", "input", "nested/input"]);
  try {
    const child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
    try {
      const [status, output] = await Promise.all([child.exited, readAll(child.stderr)]);
      expect(status).toEqual(exited(4));
      expect(output).toEqual(stderr);
    } finally {
      await child.dispose();
    }
    expect(local).not.toHaveBeenCalled();
    expect(fixture.machineSpawn).toHaveBeenCalledOnce();
    expect(fixture.machineSpawn.mock.calls[0]?.[0]).toEqual(input);
    expect(fixture.read("input")).toBe("a\n");
    expect(fixture.read("nested/input")).toBe("a\n");
    expect(fixture.filesystem.readdir("/workspace").sort()).toEqual(["input", "nested"]);
    expect(fixture.filesystem.readdir("/workspace/nested")).toEqual(["input"]);
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.close();
  }
});
