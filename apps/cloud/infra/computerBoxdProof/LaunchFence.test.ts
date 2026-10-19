// @effect-diagnostics nodeBuiltinImport:off - tests exercise the native lock with owned temporary files and child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { BOXD_PROOF_LAUNCH_FENCE } from "./LaunchFence.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const python = "/usr/bin/python3";
const loadFence = `import sys, os, json\nscope = {"__name__": "proof_fence_test"}\nexec(${JSON.stringify(BOXD_PROOF_LAUNCH_FENCE)}, scope)\n`;

describe("proof native launch fence", () => {
  it("rejects a provider setup dispatched before quiesce but admitted afterward", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "boxd-launch-fence-")),
    );
    const fence = NodePath.join(root, "fence");
    const group = NodePath.join(root, "uncreated-group");
    const marker = NodePath.join(root, "unexpected-runner");
    const delayed = NodeChildProcess.spawn(
      python,
      [
        "-u",
        "-c",
        `${loadFence}
print("dispatched", flush=True)
sys.stdin.read(1)
try:
    scope["launch"](${JSON.stringify(fence)}, ${JSON.stringify(group)}, [${JSON.stringify(python)}, "-c", ${JSON.stringify(`open(${JSON.stringify(marker)}, "w").write("started")`)}])
except RuntimeError as error:
    if str(error) != "launch is permanently fenced":
        raise
    print("late-launch-refused", flush=True)
else:
    raise RuntimeError("late launch started")
`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const dispatched = Promise.withResolvers<void>();
    delayed.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("dispatched\n")) dispatched.resolve();
    });
    delayed.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const completion = new Promise<number | null>((resolve, reject) => {
      delayed.once("error", reject);
      delayed.once("exit", resolve);
    });
    try {
      await Promise.race([
        dispatched.promise,
        completion.then((code) => {
          throw new Error(`Setup exited before dispatch (${code}): ${stderr}`);
        }),
      ]);
      const result = await execute(python, [
        "-c",
        BOXD_PROOF_LAUNCH_FENCE,
        "quiesce",
        fence,
        group,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({ closed: true, populated: 0, launchFenced: true });
      delayed.stdin.end("1");
      expect(await completion).toBe(0);
      expect(stdout).toContain("late-launch-refused");
      expect(stderr).toBe("");
      await expect(NodeFSP.readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.readFile(NodePath.join(group, "cgroup.procs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const again = await execute(python, ["-c", BOXD_PROOF_LAUNCH_FENCE, "quiesce", fence, group]);
      expect(JSON.parse(again.stdout)).toEqual({ closed: true, populated: 0, launchFenced: true });
    } finally {
      delayed.stdin.destroy();
      if (delayed.exitCode === null) delayed.kill("SIGKILL");
      await completion.catch(() => undefined);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("acknowledges launch only after the native child has written its cgroup membership", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "boxd-launch-membership-")),
    );
    try {
      // Regular files stand in for the Linux control files here. Real cgroup closure is VM proof.
      const result = await execute(python, [
        "-c",
        `${loadFence}
fence = ${JSON.stringify(NodePath.join(root, "fence"))}
group = ${JSON.stringify(NodePath.join(root, "group"))}
result = scope["launch"](fence, group, ["/usr/bin/true"])
with open(group + "/cgroup.procs") as members:
    pid = int(members.read())
assert pid > 0
actual, status = os.waitpid(pid, 0)
assert actual == pid and status == 0
with open(group + "/cgroup.kill", "w") as control:
    control.write("")
with open(group + "/cgroup.events", "w") as events:
    events.write("populated 0\\n")
assert scope["quiesce"](fence, group)["closed"]
assert open(group + "/cgroup.kill").read() == "1"
print(json.dumps(result))
`,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({ launched: true, joined: true });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
