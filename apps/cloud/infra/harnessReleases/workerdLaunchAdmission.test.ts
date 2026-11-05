import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  requireWorkerdLaunchAdmission,
  requireWorkerdLaunchAdmissionSync,
} from "./workerdLaunchAdmission.ts";
import { captureWorkerdBuiltinInventory } from "./workerdBuiltinInventory.ts";

const createTestHarness = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error("Unexpected Wrangler start");
  }),
);
vi.mock("wrangler", () => ({ createTestHarness }));
vi.mock("esbuild", () => ({ build: vi.fn() }));
vi.mock("node:os", { spy: true });
vi.mock("node:fs", { spy: true });
vi.mock("node:fs/promises", { spy: true });
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

let home: string;
let pool: string;
let pidfile: string;
let pause: string;
const children = new Set<NodeChildProcess.ChildProcess>();
const realChildProcess = await vi.importActual<typeof NodeChildProcess>("node:child_process");

async function expectRefused() {
  await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
  expect(() => requireWorkerdLaunchAdmissionSync()).toThrow("WORKERD_LAUNCH_REFUSED");
}

async function expectAdmitted() {
  await expect(requireWorkerdLaunchAdmission()).resolves.toBeUndefined();
  expect(requireWorkerdLaunchAdmissionSync()).toBeUndefined();
}

async function childProcess() {
  const child = NodeChildProcess.spawn(NodeProcess.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  children.add(child);
  await NodeEvents.EventEmitter.once(child, "spawn");
  return child;
}

beforeEach(async () => {
  home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workerd-admission-"));
  pool = NodePath.join(home, ".t3", "heavy-slots-native");
  pidfile = NodePath.join(pool, "slot-1", "pid");
  pause = NodePath.join(home, ".t3", "heavy-slots-paused");
  await NodeFSP.mkdir(NodePath.dirname(pidfile), { recursive: true });
  await NodeFSP.writeFile(pidfile, `${NodeProcess.ppid}\n`);
  vi.mocked(NodeOS.homedir).mockReturnValue(home);
  vi.stubEnv("HEAVY_SLOT_ACTIVE", "1");
  createTestHarness.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = NodeEvents.EventEmitter.once(child, "exit");
    child.kill();
    await exited;
  }
  children.clear();
  await NodeFSP.rm(home, { recursive: true, force: true });
});

describe("Workerd launch admission", () => {
  it("admits a live ancestor-owned native slot in both entry points", async () => {
    await expectAdmitted();
  });

  it("admits an indirect ancestor through the wrapper's child-command chain", async () => {
    const grandparent = realChildProcess
      .execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(NodeProcess.ppid)], {
        encoding: "utf8",
      })
      .trim();
    await NodeFSP.writeFile(pidfile, `${grandparent}\n`);
    await expectAdmitted();
  });

  it("refuses a slot released while ancestry is being probed", async () => {
    vi.mocked(NodeChildProcess.execFile).mockImplementationOnce((...args) => {
      NodeFS.writeFileSync(pidfile, "2\n");
      return realChildProcess.execFile(...args);
    });
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
    await NodeFSP.writeFile(pidfile, `${NodeProcess.ppid}\n`);
    vi.mocked(NodeChildProcess.execFileSync).mockImplementationOnce((...args) => {
      NodeFS.writeFileSync(pidfile, "2\n");
      return realChildProcess.execFileSync(...args);
    });
    expect(() => requireWorkerdLaunchAdmissionSync()).toThrow("WORKERD_LAUNCH_REFUSED");
  });

  it("uses the OS home convention when HOME is absent", async () => {
    vi.stubEnv("HOME", undefined);
    await expectAdmitted();
    expect(NodeOS.homedir).toHaveBeenCalled();
  });

  it.each([undefined, "", "0", "true", " 1", "2"])("refuses HEAVY_SLOT_ACTIVE=%s", async (flag) => {
    vi.stubEnv("HEAVY_SLOT_ACTIVE", flag);
    await expectRefused();
  });

  it("refuses the inventory entry point before starting Wrangler without admission", async () => {
    vi.stubEnv("HEAVY_SLOT_ACTIVE", undefined);
    await expect(captureWorkerdBuiltinInventory([])).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
    expect(createTestHarness).not.toHaveBeenCalled();
  });

  it("refuses a spoofed flag without an allocated slot", async () => {
    await NodeFSP.rm(NodePath.dirname(pidfile), { recursive: true });
    await expectRefused();
  });

  it("refuses a foreign live process even though its slot PID exists", async () => {
    const child = await childProcess();
    await NodeFSP.writeFile(pidfile, `${child.pid}\n`);
    await expectRefused();
  });

  it("refuses the caller's own PID instead of an ancestor", async () => {
    await NodeFSP.writeFile(pidfile, `${NodeProcess.pid}\n`);
    await expectRefused();
  });

  it("refuses a stale slot whose process exited", async () => {
    const child = await childProcess();
    const exited = NodeEvents.EventEmitter.once(child, "exit");
    child.kill();
    await exited;
    await NodeFSP.writeFile(pidfile, `${child.pid}\n`);
    await expectRefused();
  });

  it.each(["", "garbage", "0\n", "-1\n", "1\n", "1.5\n", "9007199254740993\n", "2\n3\n"])(
    "refuses malformed pidfile %j",
    async (content) => {
      await NodeFSP.writeFile(pidfile, content);
      await expectRefused();
    },
  );

  it.each([" ", "\n\n", "\t", "\r\n"])(
    "refuses malformed ancestor pidfile suffix %j",
    async (suffix) => {
      await NodeFSP.writeFile(pidfile, `${NodeProcess.ppid}${suffix}`);
      await expectRefused();
    },
  );

  it("refuses a slot directory with a malformed name", async () => {
    await NodeFSP.rename(NodePath.dirname(pidfile), `${NodePath.dirname(pidfile)}\n`);
    await expectRefused();
  });

  it("refuses a pause even with a valid slot", async () => {
    await NodeFSP.writeFile(pause, "paused");
    await expectRefused();
  });

  it("refuses a dangling pause marker", async () => {
    await NodeFSP.symlink(NodePath.join(home, "missing"), pause);
    await expectRefused();
  });

  it("rechecks pause and slot ownership on every admission", async () => {
    await expectAdmitted();
    await NodeFSP.writeFile(pause, "paused");
    await expectRefused();
    await NodeFSP.rm(pause);
    await expectAdmitted();
    await NodeFSP.rm(pidfile);
    await expectRefused();
  });

  it("ignores generic pools, command names and environment-supplied pidfiles", async () => {
    const generic = NodePath.join(home, ".t3", "heavy-slots", "slot-1", "pid");
    await NodeFSP.mkdir(NodePath.dirname(generic), { recursive: true });
    await NodeFSP.rename(pidfile, generic);
    await NodeFSP.writeFile(NodePath.join(pool, "slot-1", "cmd"), "workerd mobile-native-client");
    vi.stubEnv("HEAVY_SLOT_PIDFILE", generic);
    vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", generic);
    vi.stubEnv("SIGNALBOX_WORKERD_OWNER", "owner");
    vi.stubEnv("SIGNALBOX_WORKERD_BATCH", "batch");
    await expectRefused();
  });

  it("does not require retired reservation variables", async () => {
    vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", undefined);
    vi.stubEnv("SIGNALBOX_WORKERD_OWNER", undefined);
    vi.stubEnv("SIGNALBOX_WORKERD_BATCH", undefined);
    await expectAdmitted();
  });

  it("refuses a missing native pool", async () => {
    await NodeFSP.rm(pool, { recursive: true });
    await expectRefused();
  });

  it("refuses an unreadable native pool", async () => {
    await NodeFSP.chmod(pool, 0);
    try {
      await expectRefused();
    } finally {
      await NodeFSP.chmod(pool, 0o700);
    }
  });

  it("refuses an unreadable pidfile", async () => {
    await NodeFSP.chmod(pidfile, 0);
    try {
      await expectRefused();
    } finally {
      await NodeFSP.chmod(pidfile, 0o600);
    }
  });

  it("fails closed when a pause probe fails", async () => {
    vi.spyOn(NodeFSP, "lstat").mockRejectedValueOnce(new Error("permission denied"));
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
    vi.spyOn(NodeFS, "lstatSync").mockImplementationOnce(() => {
      throw new Error("permission denied");
    });
    expect(() => requireWorkerdLaunchAdmissionSync()).toThrow("WORKERD_LAUNCH_REFUSED");
  });

  it("fails closed when a process ancestry probe fails", async () => {
    vi.mocked(NodeChildProcess.execFile).mockImplementationOnce(() => {
      throw new Error("ps failed");
    });
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
    vi.mocked(NodeChildProcess.execFileSync).mockImplementationOnce(() => {
      throw new Error("ps failed");
    });
    expect(() => requireWorkerdLaunchAdmissionSync()).toThrow("WORKERD_LAUNCH_REFUSED");
  });

  it.each(["", "not a pid", "2\n3\n", "9007199254740993", `${NodeProcess.pid}`])(
    "fails closed on invalid or cyclic ancestry %j",
    (output) => {
      vi.mocked(NodeChildProcess.execFileSync).mockReturnValueOnce(output);
      expect(() => requireWorkerdLaunchAdmissionSync()).toThrow("WORKERD_LAUNCH_REFUSED");
    },
  );

  it.each(["", "relative/home"])("fails closed without an absolute home %j", async (value) => {
    vi.mocked(NodeOS.homedir).mockReturnValue(value);
    await expectRefused();
  });

  it("fails closed when the OS home lookup fails", async () => {
    vi.mocked(NodeOS.homedir).mockImplementation(() => {
      throw new Error("home lookup failed");
    });
    await expectRefused();
  });
});
