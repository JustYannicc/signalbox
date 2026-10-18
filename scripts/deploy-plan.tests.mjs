import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

NodeTest.test("trusted planning uses PR-installed Alchemy and its own plan checker", () => {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-plan-source-"));
  const cloud = NodePath.join(temporary, "apps", "cloud");
  const alchemy = NodePath.join(cloud, "node_modules", ".bin", "alchemy");
  const bin = NodePath.join(temporary, "bin");
  const plans = NodePath.join(temporary, "plans");
  const alchemyCwd = NodePath.join(temporary, "alchemy-cwd");
  const checkerArgs = NodePath.join(temporary, "checker-args");
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  const planScript = NodePath.join(repoRoot, "apps", "cloud", "infra", "plan.sh");
  NodeFS.mkdirSync(NodePath.dirname(alchemy), { recursive: true });
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.mkdirSync(plans, { recursive: true });
  NodeFS.writeFileSync(
    alchemy,
    [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$PWD" > "$PLAN_ALCHEMY_CWD"',
      'printf "Plan: noop\\n"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const nodeShim = NodePath.join(bin, "node");
  NodeFS.writeFileSync(
    nodeShim,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$PLAN_CHECKER_ARGS"\n',
    {
      mode: 0o755,
    },
  );

  try {
    const result = NodeChildProcess.spawnSync("bash", [planScript, "pr-42"], {
      cwd: cloud,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PLAN_ALCHEMY_CWD: alchemyCwd,
        PLAN_CHECKER_ARGS: checkerArgs,
        RUNNER_TEMP: plans,
      },
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.equal(NodeFS.readFileSync(alchemyCwd, "utf8").trim(), NodeFS.realpathSync(cloud));
    NodeAssert.deepEqual(NodeFS.readFileSync(checkerArgs, "utf8").trimEnd().split("\n"), [
      NodePath.join(repoRoot, "apps", "cloud", "infra", "check-plan.ts"),
      "pr-42",
      NodePath.join(plans, "alchemy-plan-pr-42.txt"),
    ]);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
});
