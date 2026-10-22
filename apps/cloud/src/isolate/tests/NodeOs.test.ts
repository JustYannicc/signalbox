import { describe, expect, it } from "@effect/vitest";

import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";

import { createNodeOs } from "../NodeOs.ts";
import type { NodeRuntimeIdentity } from "../NodeProcess.ts";

function identity(pid: number, values: Partial<NodeRuntimeIdentity> = {}): NodeRuntimeIdentity {
  return {
    version: "v22.12.0",
    versions: { node: "22.12.0" },
    platform: "linux",
    arch: "x64",
    homedir: `/home/host-${pid}`,
    tmpdir: `/tmp/host-${pid}`,
    pid,
    ppid: 1,
    execPath: "/usr/bin/node",
    argv0: "node",
    argv: ["node"],
    ...values,
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Node os facet", () => {
  it("uses explicit host identity and observes host-local HOME and temp environment changes", () => {
    const firstEnv = { HOME: "/home/first-env", TMPDIR: "/tmp/first-env/" };
    const first = createNodeOs({ env: firstEnv, identity: identity(91) });
    const second = createNodeOs({
      env: {},
      identity: identity(92, {
        arch: "arm64",
        user: { username: "host-user", uid: 1000, gid: 1000, shell: "/bin/sh" },
      }),
    });

    expect(first.platform()).toBe("linux");
    expect(first.arch()).toBe("x64");
    expect(first.type()).toBe("Linux");
    expect(first.endianness()).toBe("LE");
    expect(first.homedir()).toBe("/home/first-env");
    expect(first.tmpdir()).toBe("/tmp/first-env");
    expect(thrownBy(() => first.userInfo())).toMatchObject({ code: "ENOTSUP" });
    expect(second.homedir()).toBe("/home/host-92");
    expect(second.tmpdir()).toBe("/tmp/host-92");
    expect(second.userInfo()).toEqual({
      username: "host-user",
      uid: 1000,
      gid: 1000,
      shell: "/bin/sh",
      homedir: "/home/host-92",
    });

    firstEnv.HOME = "/home/changed";
    firstEnv.TMPDIR = "/scratch/changed/";
    expect(first.homedir()).toBe("/home/changed");
    expect(first.tmpdir()).toBe("/scratch/changed");
    expect(second.homedir()).toBe("/home/host-92");
  });

  it("requires explicit host version, platform, architecture and directory identity", () => {
    expect(() =>
      createNodeOs({
        env: {},
        identity: identity(93, { platform: "", homedir: "" }),
      }),
    ).toThrow(TypeError);
  });

  it("reports the configured machine identity without exposing the execution host", () => {
    const os = createNodeOs({
      env: {},
      identity: identity(94),
      systemIdentity: systemIdentityForThread("example", {
        release: "6.12.8-production",
        version: "#1 SMP PREEMPT_DYNAMIC",
        machine: "x86_64",
        hostnamePolicy: "thread",
        verification: "measured",
      }),
    });
    expect(os.release()).toBe("6.12.8-production");
    expect(os.version()).toBe("#1 SMP PREEMPT_DYNAMIC");
    expect(os.hostname()).toBe("t-example");
    expect(os.machine()).toBe("x86_64");
    expect(os.platform()).toBe("linux");
    expect(os.arch()).toBe("x64");
    expect(os.type()).toBe("Linux");
  });

  it("reports real host metrics and interfaces as unsupported", () => {
    const os = createNodeOs({ env: {}, identity: identity(94) });

    expect(thrownBy(() => os.availableParallelism())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => os.getPriority(94))).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => os.setPriority(94, 0))).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => os.totalmem())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => os.freemem())).toMatchObject({ code: "ENOTSUP" });
    expect(thrownBy(() => os.networkInterfaces())).toMatchObject({ code: "ENOTSUP" });
    expect(Object.isFrozen(os.constants)).toBe(true);
  });

  it("uses only an explicit positive safe host parallelism value", () => {
    const os = createNodeOs({
      env: {},
      identity: identity(95, { availableParallelism: 4 }),
    });
    expect(os.availableParallelism()).toBe(4);

    for (const availableParallelism of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createNodeOs({
          env: {},
          identity: identity(96, { availableParallelism }),
        }),
      ).toThrow(TypeError);
    }
  });
});
