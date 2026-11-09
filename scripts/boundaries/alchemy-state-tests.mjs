import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { parse } from "yaml";

import { checkAlchemyState, sharedCloudflareStateCalls } from "./alchemy-state.mjs";

const sharedState = 'import * as Cloudflare from "alchemy/Cloudflare";\nCloudflare.state();';

NodeTest.test("disposable infra and proof stacks cannot bootstrap account state", () => {
  const files = [
    "infra/new-probe/alchemy.run.ts",
    "apps/cloud/infra/isolateProbe/alchemy.run.ts",
    "apps/cloud/proofs/new-stack.ts",
    "experiments/probe-stack.ts",
  ];
  NodeAssert.deepEqual(
    checkAlchemyState("unused", files, () => sharedState).map((message) => message.split(":")[0]),
    files,
  );
});

NodeTest.test("production and relay stacks cannot bootstrap shared state either", () => {
  const files = [
    "apps/cloud/alchemy.run.ts",
    "infra/relay/alchemy.run.ts",
    "infra/other-production/alchemy.run.ts",
  ];
  NodeAssert.deepEqual(
    checkAlchemyState("unused", files, () => sharedState).map((message) => message.split(":")[0]),
    files,
  );
});

NodeTest.test("aliases and multiline calls are caught without matching comments or strings", () => {
  const source = `
import * as CF from "alchemy/Cloudflare";
import { state as sharedState } from "alchemy/Cloudflare/StateStore/State";
import { state as newerState } from "@alchemy.run/cloudflare";
// CF.state();
const example = "CF.state()";
CF
  .state(
  );
sharedState();
CF["state"]();
newerState();
`;
  NodeAssert.deepEqual(sharedCloudflareStateCalls("infra/stack.ts", source), [7, 10, 11, 12]);
  NodeAssert.deepEqual(
    sharedCloudflareStateCalls(
      "infra/stack.ts",
      `
import * as Alchemy from "alchemy";
Alchemy.localState();
`,
    ),
    [],
  );
});

NodeTest.test("reference code is excluded by the repository's vendored ownership", () => {
  NodeAssert.deepEqual(
    checkAlchemyState(
      "unused",
      [".repos/alchemy-effect/test/proof.ts", "apps/cloud/src/isolate/node/vm/vendor/proof.ts"],
      () => sharedState,
    ),
    [],
  );
});

NodeTest.test(
  "the current repository's infra and proof stacks respect the shared-state boundary",
  () => {
    const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
    const files = NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "-c", "-o", "--exclude-standard", "-z"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    )
      .split("\0")
      .filter(Boolean);
    NodeAssert.deepEqual(checkAlchemyState(root, files), []);
  },
);

NodeTest.test("probe workflows preserve local state and stage through always-run destroy", () => {
  const workflows = ["bun-format-canary.yml", "sync-probe.yml"];
  for (const file of workflows) {
    const workflow = parse(
      NodeFS.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"),
    );
    const job = Object.values(workflow.jobs).find((item) =>
      item.steps.some((step) => step.id === "deploy"),
    );
    NodeAssert.ok(job, file);
    const deployIndex = job.steps.findIndex((step) => step.id === "deploy");
    const destroyIndex = job.steps.findIndex((step) => /^Destroy.*probe stack$/.test(step.name));
    NodeAssert.ok(destroyIndex > deployIndex, file);
    const deploy = job.steps[deployIndex];
    const destroy = job.steps[destroyIndex];
    NodeAssert.equal(deploy["working-directory"], "apps/cloud", file);
    NodeAssert.equal(destroy["working-directory"], deploy["working-directory"], file);
    NodeAssert.equal(destroy.env?.STAGE, deploy.env?.STAGE, file);
    NodeAssert.match(destroy.if, /always\(\)/, file);
    for (const step of job.steps.slice(deployIndex + 1, destroyIndex)) {
      NodeAssert.doesNotMatch(step.uses ?? "", /^actions\/checkout@/, file);
      NodeAssert.doesNotMatch(step.run ?? "", /git clean|rm[^\n]*\.alchemy/, file);
    }
  }
});
