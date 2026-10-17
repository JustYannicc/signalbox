import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { assertDeployWorkflowPolicy, currentDeployWorkflow } from "./deploy-workflow-policy.mjs";
import { findFileScriptCalls, maskShellComments } from "./deploy-workflow-shell.mjs";

const prCheckout = `      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`;

function fixture(steps) {
  return `jobs:
  deploy_preview:
    if: github.event_name == 'pull_request'
    steps:
${prCheckout}${steps}`;
}

function jobDefaultWorkingDirectoryFixture(steps) {
  return `jobs:
  deploy_preview:
    if: github.event_name == 'pull_request'
    defaults:
      run:
        working-directory: apps/cloud
    steps:
${prCheckout}${steps}`;
}

NodeTest.test("the deploy workflow keeps PR scripts guarded or on trusted main", () => {
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(currentDeployWorkflow()));
});

NodeTest.test("an unguarded Node script from the PR checkout fails", () => {
  const workflow = fixture(`      - name: Release event
        working-directory: apps/cloud
        run: node infra/release-event.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script apps\/cloud\/infra\/release-event\.ts/,
  );
});

NodeTest.test("comment lines cannot shift an optional guard over an unguarded script", () => {
  const workflow = fixture(`      - name: Release event
        working-directory: apps/cloud
        run: |
          if [[ -f infra/release-event.ts ]]; then
            # ${"x".repeat(160)}
          fi
          node infra/release-event.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script apps\/cloud\/infra\/release-event\.ts/,
  );
});

NodeTest.test("comment lines cannot shift a required package script into a guard", () => {
  const workflow = fixture(`      - name: Build
        run: |
          # ${"x".repeat(160)}
          if [[ -f apps/web/package.json ]]; then
            vp run --filter @t3tools/web build
          fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(workflow), /guards a required package script/);
});

NodeTest.test("comment lines cannot shift a required deploy binary into a guard", () => {
  const workflow = fixture(`      - name: Deploy
        working-directory: apps/cloud
        run: |
          # ${"x".repeat(160)}
          if [[ -f node_modules/.bin/alchemy ]]; then
            ./node_modules/.bin/alchemy deploy --stage pr-1
          fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(workflow), /guards a required local binary/);
});

NodeTest.test("commented-out guards and script calls do not affect policy", () => {
  const workflow = fixture(`      - name: Release event
        working-directory: apps/cloud
        run: |
          # if [[ -f infra/release-event.ts ]]; then node infra/release-event.ts; fi
          node infra/release-event.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script apps\/cloud\/infra\/release-event\.ts/,
  );
});

NodeTest.test("quoted hashes stay data and cannot create a fake guard", () => {
  const workflow = fixture(`      - name: Release event
        run: |
          echo "value # if [[ -f scripts/release.ts ]]; then node scripts/release.ts; fi"
          echo '\${#ARGS} # if [[ -f scripts/release.ts ]]; then node scripts/release.ts; fi'
          node scripts/release.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script scripts\/release\.ts/,
  );
});

NodeTest.test("escaped CRLF continuations are masked without shifting call offsets", () => {
  const source = "node \\\r\n  scripts/release.ts";
  const masked = maskShellComments(source);
  NodeAssert.equal(masked.length, source.length);
  NodeAssert.deepEqual(
    findFileScriptCalls(masked).map(({ file }) => file),
    ["scripts/release.ts"],
  );
});

NodeTest.test("comments do not break a valid optional script guard", () => {
  const workflow = fixture(`      - name: Release event
        working-directory: apps/cloud
        run: |
          # A missing telemetry file is expected on older PR heads.
          if [[ -f infra/release-event.ts ]]; then
            # If it exists, failures still fail this step.
            node infra/release-event.ts
          fi
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow));
});

NodeTest.test("Bash parameter length expansion does not hide a same-line script", () => {
  const workflow = fixture(`      - name: Release event
        run: |
          if (( \${#ARGS} > 0 )); then echo x; fi; node scripts/release.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script scripts\/release\.ts/,
  );
});

NodeTest.test("Bash parameter length expansion cannot extend an optional guard", () => {
  const workflow = fixture(`      - name: Release event
        run: |
          if [[ -f scripts/release.ts ]]; then echo \${#X}; fi
          node scripts/release.ts
          if [[ -f other ]]; then echo; fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script scripts\/release\.ts/,
  );
});

NodeTest.test("Bash parameter length expansion cannot hide required build or deploy steps", () => {
  const build = fixture(`      - name: Build
        run: |
          if [[ -f scripts/release.ts ]]; then echo \${#X}; vp run build; fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(build), /guards a required package script/);

  const deploy = fixture(`      - name: Deploy
        working-directory: apps/cloud
        run: |
          if [[ -f scripts/release.ts ]]; then echo \${#X}; ./node_modules/.bin/alchemy deploy; fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(deploy), /guards a required local binary/);
});

NodeTest.test("an escaped line break cannot hide an unguarded script", () => {
  const workflow = fixture(`      - name: Release event
        run: |
          node \\
            scripts/release.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script scripts\/release\.ts/,
  );
});

NodeTest.test("an escaped line break preserves a matching file guard", () => {
  const workflow = fixture(`      - name: Release event
        run: |
          if [[ -f scripts/release.ts ]]; then
            node \\
              scripts/release.ts
          fi
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow));
});

NodeTest.test("nested conditionals inside a file guard fail closed", () => {
  const workflow = fixture(`      - name: Build
        run: |
          if [[ -f scripts/release.ts ]]; then
            if true; then echo nested; fi
            vp run build
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /uses nested conditionals inside file-existence guards, which are unsupported/,
  );

  const nestedElse = fixture(`      - name: Build
        run: |
          if [[ -f scripts/release.ts ]]; then
            echo optional
          else
            if true; then echo nested; fi
            vp run build
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(nestedElse),
    /uses nested conditionals inside file-existence guards, which are unsupported/,
  );
});

NodeTest.test("common Node and shell wrappers cannot hide PR scripts", () => {
  const commands = [
    "node --experimental-strip-types scripts/release.ts",
    "node --import tsx scripts/release.ts",
    "node -r dotenv/config scripts/release.ts",
    "node -r=dotenv/config scripts/release.ts",
    "env RELEASE_STAGE=preview node scripts/release.ts",
    "timeout 60 node scripts/release.ts",
    "tsx scripts/release.ts",
    "npx tsx scripts/release.ts",
    "vp exec node scripts/release.ts",
    "node scripts/release.mts",
    "node scripts/release.cts",
    "EVENT=`node scripts/release.ts`",
  ];
  for (const command of commands) {
    const workflow = fixture(`      - name: Release event
        run: ${command}
`);
    NodeAssert.throws(
      () => assertDeployWorkflowPolicy(workflow),
      /PR-head script scripts\/release\.(?:[mc])?ts/,
      command,
    );
  }
});

NodeTest.test("common Node and shell wrappers allow a matching file guard", () => {
  const commands = [
    "node --experimental-strip-types scripts/release.ts",
    "node --import tsx scripts/release.ts",
    "node -r dotenv/config scripts/release.ts",
    "node -r=dotenv/config scripts/release.ts",
    "env RELEASE_STAGE=preview node scripts/release.ts",
    "timeout 60 node scripts/release.ts",
    "tsx scripts/release.ts",
    "npx tsx scripts/release.ts",
    "vp exec node scripts/release.ts",
    "node scripts/release.mts",
    "node scripts/release.cts",
    "EVENT=`node scripts/release.ts`",
  ];
  for (const command of commands) {
    const script =
      ["scripts/release.mts", "scripts/release.cts"].find((path) => command.includes(path)) ??
      "scripts/release.ts";
    const workflow = fixture(`      - name: Release event
        run: |
          if [[ -f ${script} ]]; then
            ${command}
          fi
`);
    NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow), command);
  }
});

NodeTest.test("Node module hook scripts are checked independently from the main script", () => {
  const mainScriptIsGuarded = fixture(`      - name: Release event
        run: |
          if [[ -f scripts/preload.cjs ]]; then
            node -r ./scripts/preload.cjs scripts/release.ts
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(mainScriptIsGuarded),
    (error) => error.message.includes("PR-head script scripts/release.ts"),
  );

  const shortOption = fixture(`      - name: Release event
        run: |
          if [[ -f scripts/release.ts ]]; then
            node -r ./scripts/preload.cjs scripts/release.ts
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(shortOption),
    (error) => error.message.includes("PR-head script scripts/preload.cjs"),
  );
});

NodeTest.test("Node require options identify preload and main scripts separately", () => {
  for (const option of ["-r ./scripts/preload.cjs", "-r=./scripts/preload.cjs"]) {
    const calls = findFileScriptCalls(maskShellComments(`node ${option} scripts/release.ts`));
    NodeAssert.deepEqual(
      calls.map(({ file }) => file).sort(),
      ["./scripts/preload.cjs", "scripts/release.ts"],
      option,
    );
  }
});

NodeTest.test("Node module hook scripts can use a matching file guard", () => {
  const commands = [
    ["node --import ./scripts/preload.ts", "scripts/preload.ts"],
    ["node --require=./scripts/preload.cjs", "scripts/preload.cjs"],
    ["node --loader ./scripts/preload.mjs", "scripts/preload.mjs"],
    ["node -r ./scripts/preload.cjs", "scripts/preload.cjs"],
    ["node -r=./scripts/preload.cjs", "scripts/preload.cjs"],
  ];
  for (const [command, script] of commands) {
    const workflow = fixture(`      - name: Release event
        run: |
          if [[ -f ${script} ]]; then
            ${command}
          fi
`);
    NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow), command);
  }
});

NodeTest.test("a matching file check guards an optional Node script", () => {
  const workflow = fixture(`      - name: Release event
        working-directory: apps/cloud
        run: |
          if [[ -f infra/release-event.ts ]]; then
            SIGNALBOX_STAGE=preview node infra/release-event.ts
          fi
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow));
});

NodeTest.test("job-level working directories resolve script and guard paths", () => {
  const unguarded = jobDefaultWorkingDirectoryFixture(`      - name: Release event
        run: node infra/release-event.ts
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(unguarded),
    /PR-head script apps\/cloud\/infra\/release-event\.ts/,
  );

  const guarded = jobDefaultWorkingDirectoryFixture(`      - name: Release event
        run: |
          if [[ -f infra/release-event.ts ]]; then
            node infra/release-event.ts
          fi
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(guarded));
});

NodeTest.test("a PR job stays covered if its checkout ref changes from head to merge SHA", () => {
  const workflow = fixture(`      - name: Release event
        working-directory: apps/cloud
        run: node infra/release-event.ts
`).replace("${{ github.event.pull_request.head.sha }}", "${{ github.sha }}");
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script apps\/cloud\/infra\/release-event\.ts/,
  );
});

NodeTest.test("a matching file check guards a Bash script", () => {
  const workflow = fixture(`      - name: Cleanup
        run: |
          if test -f .github/scripts/cleanup.sh; then
            bash .github/scripts/cleanup.sh
          fi
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow));
});

NodeTest.test("a guard for a different path does not protect a Bash script", () => {
  const workflow = fixture(`      - name: Cleanup
        run: |
          if test -f .github/scripts/other.sh; then
            bash .github/scripts/cleanup.sh
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script \.github\/scripts\/cleanup\.sh/,
  );
});

NodeTest.test("a missing-file guard does not protect a script in its else branch", () => {
  const workflow = fixture(`      - name: Cleanup
        run: |
          if [[ -f .github/scripts/cleanup.sh ]]; then
            echo "already present"
          else
            ./.github/scripts/cleanup.sh
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script \.github\/scripts\/cleanup\.sh/,
  );
});

NodeTest.test("a script in an elif branch is not protected by the first branch guard", () => {
  const workflow = fixture(`      - name: Release event
        run: |
          if [[ -f scripts/release.ts ]]; then
            echo "first branch"
          elif [[ "$RUN_RELEASE" == "yes" ]]; then
            node scripts/release.ts
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script scripts\/release\.(?:[mc])?ts/,
  );
});

NodeTest.test("directly executed repo scripts are also checked", () => {
  const workflow = fixture(`      - name: Cleanup
        run: ./.github/scripts/cleanup.sh
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script \.github\/scripts\/cleanup\.sh/,
  );
});

NodeTest.test("Python scripts from the PR checkout are checked", () => {
  const workflow = fixture(`      - name: Prepare release metadata
        run: python3 .github/scripts/prepare-release.py
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script \.github\/scripts\/prepare-release\.py/,
  );
});

NodeTest.test("trusted plan runs from apps/cloud and includes its transitive checker", () => {
  const workflow = fixture(`      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.repository.default_branch }}
          path: .trusted-main
          sparse-checkout: |
            /apps/cloud/infra/plan.sh
            /apps/cloud/infra/check-plan.ts
            /apps/cloud/infra/planCheck.ts
      - name: Plan
        working-directory: apps/cloud
        run: bash ../../.trusted-main/apps/cloud/infra/plan.sh pr-1
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(workflow));
});

NodeTest.test("trusted script dependencies must also be present in sparse checkout", () => {
  const workflow = fixture(`      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.repository.default_branch }}
          path: .trusted-main
          sparse-checkout: |
            /apps/cloud/infra/plan.sh
            /apps/cloud/infra/check-plan.ts
      - name: Plan
        working-directory: apps/cloud
        run: bash ../../.trusted-main/apps/cloud/infra/plan.sh pr-1
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /trusted checkout omits apps\/cloud\/infra\/planCheck\.ts/,
  );
});

NodeTest.test("a trusted plan cannot be skipped when its sparse path is missing", () => {
  const workflow = fixture(`      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.repository.default_branch }}
          path: .trusted-main
          sparse-checkout: |
            /apps/cloud/infra/check-plan.ts
      - name: Plan
        working-directory: apps/cloud
        run: |
          if [[ -f ../../.trusted-main/apps/cloud/infra/plan.sh ]]; then
            bash ../../.trusted-main/apps/cloud/infra/plan.sh pr-1
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /trusted checkout omits directly invoked script apps\/cloud\/infra\/plan\.sh/,
  );
});

NodeTest.test("a trusted plan stays required when its sparse path is present", () => {
  const workflow = fixture(`      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.repository.default_branch }}
          path: .trusted-main
          sparse-checkout: |
            /apps/cloud/infra/plan.sh
            /apps/cloud/infra/check-plan.ts
            /apps/cloud/infra/planCheck.ts
      - name: Plan
        working-directory: apps/cloud
        run: |
          if [[ -f ../../.trusted-main/apps/cloud/infra/plan.sh ]]; then
            bash ../../.trusted-main/apps/cloud/infra/plan.sh pr-1
          fi
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /guards a required plan validation/,
  );
});

NodeTest.test("trusted operational shell scripts include local script dependencies", () => {
  const workflow = fixture(`      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.repository.default_branch }}
          path: .trusted-main
          sparse-checkout: |
            /.github/scripts/call-preview-cleanup.sh
      - name: Reopen links
        run: bash .trusted-main/.github/scripts/call-preview-cleanup.sh activate 1
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /trusted checkout omits \.github\/scripts\/preview-cleanup-token\.sh/,
  );
});

NodeTest.test("trusted domain verification includes its stage configuration", () => {
  const workflow = fixture(`      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.repository.default_branch }}
          path: .trusted-main
          sparse-checkout: |
            /.github/scripts
      - name: Verify domains
        run: node .trusted-main/.github/scripts/cloudflare-preview-domains.cjs verify
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /trusted checkout omits apps\/cloud\/infra\/stage\.ts/,
  );
});

NodeTest.test("YAML anchors and step working directories are expanded before checking", () => {
  const workflow = fixture(`      - &plan
        working-directory: apps/cloud
        run: bash infra/plan.sh pr-1
      - *plan
`);
  NodeAssert.throws(
    () => assertDeployWorkflowPolicy(workflow),
    /PR-head script apps\/cloud\/infra\/plan\.sh/,
  );
});

NodeTest.test("package scripts remain required and cannot sit inside an absence guard", () => {
  const required = fixture(`      - name: Build
        run: vp run --filter @t3tools/web build
`);
  NodeAssert.doesNotThrow(() => assertDeployWorkflowPolicy(required));

  const guarded = fixture(`      - name: Build
        run: |
          if [[ -f apps/web/package.json ]]; then
            vp run --filter @t3tools/web build
          fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(guarded), /guards a required package script/);

  const filtered = fixture(`      - name: Build
        run: |
          if [[ -f apps/web/package.json ]]; then
            pnpm --filter @t3tools/web run build
          fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(filtered), /guards a required package script/);
});

NodeTest.test("the deploy binary remains required", () => {
  const guarded = fixture(`      - name: Deploy
        working-directory: apps/cloud
        run: |
          if [[ -f node_modules/.bin/alchemy ]]; then
            ./node_modules/.bin/alchemy deploy --stage pr-1
          fi
`);
  NodeAssert.throws(() => assertDeployWorkflowPolicy(guarded), /guards a required local binary/);
});
