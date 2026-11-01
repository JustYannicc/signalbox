import { describe, expect, it } from "@effect/vitest";
import { detachedProcessFixture } from "./NodeChildProcessDetached.fixture.ts";

describe("detached Node children over the kernel process namespace", () => {
  it.each([
    ["kernel", "pipes", false],
    ["kernel", "pipes", true],
    ["kernel", "output-file", false],
    ["kernel", "output-file", true],
    ["computer", "pipes", false],
    ["computer", "pipes", true],
    ["computer", "output-file", false],
    ["computer", "output-file", true],
  ] as const)(
    "runs the retained Claude Bash spawn shape through %s with %s and login=%s",
    async (route, output, login) => {
      const f = detachedProcessFixture(route);
      try {
        const sibling = f.childProcess.spawn("/bin/bash", ["sibling"], { stdio: "ignore" });
        const siblingClosed = f.track(sibling);
        const fd = output === "output-file" ? f.fs.openSync("/work/bash-output", "w+") : undefined;
        // Claude 2.1.303 release.js:10148/10150, SHA cddd2bc5: Bash sets detached and uses a shared output fd unless streaming.
        const options = {
          detached: true,
          cwd: "/work",
          env: { PATH: "/bin", SHELL: "/bin/bash", GIT_EDITOR: "true" },
          stdio: fd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", fd, fd],
          windowsHide: true,
        };
        const args = ["-c", ...(login ? ["-l"] : []), "leader"];
        const child = f.childProcess.spawn("/bin/bash", args, options);
        if (fd !== undefined) f.fs.closeSync(fd);
        const stdout: string[] = [];
        const stderr: string[] = [];
        child.stdout?.on("data", (chunk: Uint8Array) =>
          stdout.push(new TextDecoder().decode(chunk)),
        );
        child.stderr?.on("data", (chunk: Uint8Array) =>
          stderr.push(new TextDecoder().decode(chunk)),
        );
        child.stdin?.end();
        const childClosed = f.track(child);
        await f.entered.promise;
        expect(child.pid).toBeDefined();
        expect(f.calls.get("leader")).toMatchObject({
          args: ["/bin/bash", ...args],
          cwd: "/work",
          env: options.env,
        });
        expect(f.host.processes.lookupPid(sibling.pid!)).toMatchObject({
          status: "ok",
          value: { info: { processGroupId: 1 } },
        });
        for (const name of ["leader", "child", "grandchild"]) {
          const lookup = f.host.processes.lookupPid(f.members.get(name)!);
          expect(lookup).toMatchObject({
            status: "ok",
            value: { info: { processGroupId: child.pid } },
          });
        }
        expect(f.process.kill(-child.pid!, 0)).toBe(true);
        expect(f.signals.size).toBe(0);
        f.finished.resolve();
        await Promise.all([childClosed, siblingClosed]);
        if (output === "pipes") {
          expect(stdout.join("")).toBe("out:leader\n");
          expect(stderr.join("")).toBe("err:leader\n");
        } else {
          expect(f.fs.readFileSync("/work/bash-output").toString()).toBe(
            "out:leader\nerr:leader\n",
          );
        }
      } finally {
        await f.close();
      }
    },
  );

  it.each(["kernel", "computer"] as const)(
    "signals the live %s leader and all descendants",
    async (route) => {
      const f = detachedProcessFixture(route);
      try {
        const leader = f.childProcess.spawn("/bin/bash", ["-c", "leader"], {
          detached: true,
          stdio: "ignore",
        });
        const leaderClosed = f.track(leader);
        await f.entered.promise;
        expect(f.process.kill(-leader.pid!, "SIGTERM")).toBe(true);
        await Promise.all([
          leaderClosed,
          f.descendantClosed("child"),
          f.descendantClosed("grandchild"),
        ]);
        expect([...f.signals].sort()).toEqual(["child", "grandchild", "leader"]);
        expect(leader.signalCode).toBe("SIGTERM");
      } finally {
        await f.close();
      }
    },
  );

  it.each(["kernel", "computer"] as const)(
    "signals reparented descendants after the %s leader closes",
    async (route) => {
      const f = detachedProcessFixture(route);
      try {
        const sibling = f.childProcess.spawn("/bin/bash", ["sibling"], {
          stdio: "ignore",
          detached: true,
        });
        const siblingClosed = f.track(sibling);
        const leader = f.childProcess.spawn("/bin/bash", ["-c", "leader"], {
          detached: true,
          stdio: "ignore",
        });
        const leaderClosed = f.track(leader);
        await f.entered.promise;
        const group = leader.pid!;
        f.finish("leader");
        await leaderClosed;
        expect(leader.exitCode).toBe(0);
        expect(f.host.processes.lookupPid(group).status).toBe("error");
        expect(f.host.processes.lookupPid(f.members.get("child")!)).toMatchObject({
          status: "ok",
          value: { status: "running", info: { parentPid: 1, processGroupId: group } },
        });
        expect(f.process.kill(-group, "SIGTERM")).toBe(true);
        await Promise.all([f.descendantClosed("child"), f.descendantClosed("grandchild")]);
        expect([...f.signals].sort()).toEqual(["child", "grandchild"]);
        expect(f.host.processes.lookupPid(sibling.pid!)).toMatchObject({
          status: "ok",
          value: { status: "running" },
        });
        f.finish("sibling");
        await siblingClosed;
      } finally {
        await f.close();
      }
    },
  );

  it.each(["kernel", "computer"] as const)(
    "keeps an extra sandbox descriptor explicitly unsupported through %s",
    async (route) => {
      const f = detachedProcessFixture(route);
      try {
        const fd = f.fs.openSync("/work/bash-output", "w+");
        expect(() =>
          f.childProcess.spawn("/bin/bash", ["-c", "leader"], {
            detached: true,
            stdio: ["pipe", fd, fd, "pipe"],
          }),
        ).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
        f.fs.closeSync(fd);
        expect(f.host.processes.size).toBe(0);
      } finally {
        await f.close();
      }
    },
  );

  it("rejects a non-boolean detached flag before creating a process", async () => {
    const f = detachedProcessFixture("kernel");
    try {
      expect(() =>
        Reflect.apply(f.childProcess.spawn, undefined, ["/bin/bash", [], { detached: "true" }]),
      ).toThrow(TypeError);
      expect(f.host.processes.size).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("keeps inline synchronous detached execution explicitly unavailable", async () => {
    const f = detachedProcessFixture("kernel");
    try {
      expect(() => f.childProcess.spawnSync("/bin/bash", ["leader"], { detached: true })).toThrow(
        "detached",
      );
      expect(f.host.processes.size).toBe(0);
    } finally {
      await f.close();
    }
  });
});
