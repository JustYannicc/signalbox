// @effect-diagnostics nodeBuiltinImport:off - PassThrough supplies streams for the explicit host context in these tests.
import * as NodeStream from "node:stream";
import { describe, expect, it } from "@effect/vitest";

import { createNodeProcess, type NodeProcessHostContext } from "../NodeProcess.ts";
import { inspectNodeBuiltinFunctionCapabilities } from "../../harness/NodeBuiltinInventory.ts";

type PosixCredentials = NonNullable<
  NodeProcessHostContext["filesystem"]["posixPolicy"]
>["credentials"];

const credentialMethods = ["getuid", "getgid", "geteuid", "getegid", "getgroups"] as const;
const inventoryRequests = credentialMethods.map((member) => ({
  specifier: "node:process",
  memberPath: [member],
}));

function processHost(pid: number, credentials?: PosixCredentials): NodeProcessHostContext {
  return {
    filesystem: {
      cwd: "/work",
      chdir(_path) {},
      ...(credentials === undefined ? {} : { posixPolicy: { credentials, umask: 0o022 } }),
    },
    env: {},
    identity: {
      version: "v24.0.0",
      versions: { node: "24.0.0" },
      platform: "linux",
      arch: "x64",
      homedir: "/home/guest",
      tmpdir: "/tmp",
      pid,
      ppid: 1,
      execPath: "/usr/bin/node",
      argv0: "node",
      argv: ["node"],
    },
    streams: {
      stdin: new NodeStream.PassThrough(),
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
    },
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

describe("Node process credential getters", () => {
  it("reads distinct logical IDs and returns isolated, unique groups including effective gid", () => {
    const firstGroups = [300, 300, 400];
    const first = createNodeProcess(
      processHost(81, {
        uid: 1101,
        gid: 1201,
        euid: 2101,
        egid: 2201,
        groups: firstGroups,
      }),
    );
    const second = createNodeProcess(
      processHost(82, {
        uid: 3101,
        gid: 3201,
        euid: 4101,
        egid: 4201,
        groups: [700, 700, 800, 4201, 4201],
      }),
    );
    const { getuid, getgid, geteuid, getegid, getgroups } = first;

    expect([getuid(), getgid(), geteuid(), getegid()]).toEqual([1101, 1201, 2101, 2201]);
    expect(getgroups()).toEqual([300, 400, 2201]);
    expect(second.getgroups()).toEqual([700, 800, 4201]);

    getgroups().push(999);
    firstGroups.push(500);

    expect(getgroups()).toEqual([300, 400, 2201]);
    expect(second.getgroups()).toEqual([700, 800, 4201]);
    expect([second.getuid(), second.getgid(), second.geteuid(), second.getegid()]).toEqual([
      3101, 3201, 4101, 4201,
    ]);
  });

  it("keeps missing POSIX authority explicit and inventories getter capabilities without calling them", () => {
    const unavailable = createNodeProcess(processHost(83));
    const conditional = inspectNodeBuiltinFunctionCapabilities(
      { process: unavailable },
      inventoryRequests,
    );

    expect(conditional.map(({ status }) => status)).toEqual([
      "conditional",
      "conditional",
      "conditional",
      "conditional",
      "conditional",
    ]);
    for (const [name, getter] of [
      ["getuid", unavailable.getuid],
      ["getgid", unavailable.getgid],
      ["geteuid", unavailable.geteuid],
      ["getegid", unavailable.getegid],
      ["getgroups", unavailable.getgroups],
    ] as const) {
      expect(thrownBy(getter)).toMatchObject({ code: "ENOTSUP", syscall: `process.${name}` });
    }

    const configured = createNodeProcess(
      processHost(84, { uid: 1, gid: 2, euid: 3, egid: 4, groups: [] }),
    );
    const supported = inspectNodeBuiltinFunctionCapabilities(
      { process: configured },
      inventoryRequests,
    );
    expect(supported.map(({ status }) => status)).toEqual([
      "supported",
      "supported",
      "supported",
      "supported",
      "supported",
    ]);
  });
});
