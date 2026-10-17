// @effect-diagnostics nodeBuiltinImport:off - exercises the actual Bash launcher and installer in temporary directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { CONFIG_PATH, RUNNER_SCRIPT, SETUP_COMMAND } from "./BoatRunnerSetup.ts";

describe("Boat Runner startup", () => {
  it.each(["fuseblk", "fuse.ascii-lazyfs", "unavailable"])(
    "waits for %s to become a local filesystem before creating the container",
    (filesystem) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-runner-"));
      try {
        const config = NodePath.join(dir, "machine.json");
        NodeFS.writeFileSync(config, '{"image":"runner:test"}');
        NodeFS.writeFileSync(NodePath.join(dir, "filesystem"), filesystem);
        NodeFS.writeFileSync(NodePath.join(dir, "events"), "");
        const commands = {
          stat: 'type=$(cat "$FIXTURE/filesystem"); [ "$type" != unavailable ] || exit 1; echo "$type"',
          sleep: 'echo hydrated >> "$FIXTURE/events"; echo ext4 > "$FIXTURE/filesystem"',
          docker: 'echo "docker $* filesystem=$(cat "$FIXTURE/filesystem")" >> "$FIXTURE/events"',
        };
        for (const [name, body] of Object.entries(commands)) {
          NodeFS.writeFileSync(NodePath.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
        }
        // Simulate /dev/fuse even on macOS, whose Bash rejects empty arrays with nounset.
        const script = RUNNER_SCRIPT.replaceAll(CONFIG_PATH, config).replaceAll(
          "/dev/fuse",
          config,
        );
        NodeChildProcess.execFileSync("bash", ["-c", script], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir },
          timeout: 5_000,
        });
        const events = NodeFS.readFileSync(NodePath.join(dir, "events"), "utf8").trim().split("\n");
        expect(events[0]).toBe("hydrated");
        expect(events.find((line) => line.startsWith("docker run "))).toContain("filesystem=ext4");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "retries installation without losing a pending restart: %s",
    (failRestart) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "boat-install-"));
      try {
        for (const name of ["bin", "units", "run"]) NodeFS.mkdirSync(NodePath.join(dir, name));
        NodeFS.writeFileSync(NodePath.join(dir, "events"), "");
        if (failRestart) NodeFS.writeFileSync(NodePath.join(dir, "fail"), "");
        const commands = {
          sudo: 'exec "$@"',
          flock: "exit 0",
          systemctl: `echo "$*" >> "$FIXTURE/events"
if [ "$1" = restart ] && [ -e "$FIXTURE/fail" ]; then rm "$FIXTURE/fail"; exit 1; fi`,
        };
        for (const [name, body] of Object.entries(commands)) {
          NodeFS.writeFileSync(NodePath.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
        }
        const command = SETUP_COMMAND.replaceAll("/usr/local/bin", NodePath.join(dir, "bin"))
          .replaceAll("/etc/systemd/system", NodePath.join(dir, "units"))
          .replaceAll("/run/", `${dir}/run/`)
          .replaceAll("/tmp/signalbox-runner-setup.lock", NodePath.join(dir, "setup.lock"))
          .replaceAll("/home/user/signalbox", NodePath.join(dir, "home"))
          .replaceAll("-o user -g user", "");
        const run = () =>
          NodeChildProcess.execFileSync("bash", ["-c", command], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir },
            timeout: 5_000,
          });
        if (failRestart) expect(run).toThrow();
        else run();
        run();
        run();
        const events = NodeFS.readFileSync(NodePath.join(dir, "events"), "utf8").trim().split("\n");
        expect(events.filter((line) => line === "restart signalbox-runner.service")).toHaveLength(
          failRestart ? 2 : 1,
        );
        expect(events.at(-1)).toBe("start signalbox-runner.service");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
