import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { freezeFixture, sha256, type FrozenFixture } from "./fixture.ts";
import {
  RELEASE_CRITERIA,
  type ProofEnvironment,
  type ReleaseCriteriaAssessment,
} from "./measurement.ts";
import { PendingReleaseProof, runRelease, type ReleaseOperations } from "./runner.ts";
import { createProcessOperations, runCommand } from "./process.ts";
import {
  deployReleaseProbeHost,
  measureWithDeploymentIdentity,
  prepareReleaseProbeHost,
  recoverReleaseCleanup,
  takeReleaseDeploymentCredentials,
  type DeploymentIdentity,
  type ReleaseCloudflare,
} from "./deployment.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

function evidence(fixture: FrozenFixture, environment: ProofEnvironment) {
  return {
    schemaVersion: 1,
    environment,
    runId: `${environment}-fresh-run`,
    verificationErrors: [],
    rows: fixture.requests.map((request, index) => ({
      fixture: fixture.id,
      path: request.path,
      cold: index === 0,
      request,
      inventory: fixture.inventory,
      clientWallMs: 12,
      response: {
        status: 200,
        result: { ok: true, tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"] },
      },
    })),
  };
}

function syntheticGreen(): ReleaseCriteriaAssessment {
  return {
    checks: RELEASE_CRITERIA.map((name) => ({
      name,
      status: "passed",
      detail: "Synthetic verifier only.",
    })),
    metrics: {
      moduleBytes: { state: "measured", value: 42 },
      bootTimeMs: { state: "measured", value: 1 },
      peakHeapBytes: { state: "measured", value: 1024 },
    },
  };
}

async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-runner-"));
  directories.push(root);
  const repository = NodePath.join(root, "repo");
  await NodeFSP.mkdir(NodePath.join(repository, "scripts/harness-releases"), { recursive: true });
  const source = NodePath.join(repository, "scripts/harness-releases/build.ts");
  await NodeFSP.writeFile(source, "export const frozen = true;\n");
  const git = (args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd: repository });
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture",
  ]);
  const options = {
    repository,
    output: NodePath.join(root, "run"),
    provider: "codex" as const,
    version: "0.163.0",
  };
  const calls: string[] = [];
  const operations: ReleaseOperations = {
    identity: async (provider, version) => ({
      provider,
      version,
      upstreamIdentity: `github:openai/codex:rust-v${version}`,
      sha256: "a".repeat(64),
    }),
    build: async (context) => {
      calls.push("build");
      const artifact = NodePath.join(context.output, "artifact");
      await NodeFSP.mkdir(artifact);
      await NodeFSP.writeFile(NodePath.join(artifact, "engine.wasm"), "synthetic");
      await NodeFSP.writeFile(
        NodePath.join(artifact, "manifest.json"),
        JSON.stringify({
          files: {
            "engine.wasm": { bytes: 9, sha256: sha256("synthetic") },
          },
        }),
      );
      return { artifact };
    },
    scan: async () => ({ status: "passed", detail: "Synthetic scanner." }),
    packageFixture: async (context) => {
      const fixture = NodePath.join(context.output, "fixture");
      await NodeFSP.mkdir(fixture);
      await NodeFSP.writeFile(NodePath.join(fixture, "main.js"), "export class Proof {}");
      await NodeFSP.writeFile(
        NodePath.join(fixture, "manifest.json"),
        JSON.stringify({
          id: "synthetic-release",
          mode: "facet",
          mainModule: "main.js",
          entrypoint: "Proof",
          modules: { "main.js": { path: "main.js", type: "js" } },
          paths: ["/turn"],
        }),
      );
      return fixture;
    },
    prepareDeployment: async () => {
      calls.push("prepare-deployment");
    },
    measure: async (_context, directory, environment) => {
      calls.push(environment);
      return evidence(await freezeFixture(directory), environment);
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    publish: async () => {
      calls.push("publish");
    },
  };
  return { root, source, options, operations, calls };
}

const probeModuleNames = [
  "worker.js",
  "runtime.js",
  "suspend.wasm",
  "esm.js",
  "facetSource.js",
  "wasmFixture.js",
  "moduleTransport.js",
  "moduleUpload.js",
  "codeGeneration.js",
  "childWorkerDispatch.js",
];

async function prepareProbeHost(test: Awaited<ReturnType<typeof setup>>) {
  const generated = NodePath.join(
    test.options.repository,
    "apps/cloud/infra/isolateProbe/generated",
  );
  await NodeFSP.mkdir(generated, { recursive: true });
  for (const name of probeModuleNames)
    await NodeFSP.writeFile(NodePath.join(generated, name), name);
  return prepareReleaseProbeHost(test.options.repository, test.root);
}

async function installFakeWorkerd(repository: string) {
  const cloud = NodePath.join(repository, "apps/cloud");
  const configPath = NodePath.join(cloud, "infra/isolateProbe/wrangler.jsonc");
  const wrangler = NodePath.join(repository, "node_modules/wrangler");
  const workerd = NodePath.join(wrangler, "node_modules/workerd");
  const binaryPath = NodePath.join(workerd, "bin/workerd");
  const binary = Buffer.from("fixture-workerd-binary");
  const native = {
    compatibilityDate: "2026-10-12",
    default: binaryPath,
    version: "1.20261012.1",
  };
  await NodeFSP.mkdir(NodePath.dirname(configPath), { recursive: true });
  await NodeFSP.writeFile(configPath, '{"compatibility_date":"2026-10-18"}\n');
  await NodeFSP.writeFile(NodePath.join(cloud, "package.json"), '{"name":"cloud"}\n');
  await NodeFSP.mkdir(NodePath.dirname(binaryPath), { recursive: true });
  await NodeFSP.writeFile(binaryPath, binary, { mode: 0o755 });
  await NodeFSP.writeFile(
    NodePath.join(wrangler, "package.json"),
    JSON.stringify({ name: "wrangler", version: "4.40.0" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(workerd, "package.json"),
    JSON.stringify({ name: "workerd", main: "index.cjs" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(workerd, "index.cjs"),
    `module.exports = ${JSON.stringify(native)};\n`,
  );
  return {
    binaryPath: await NodeFSP.realpath(binaryPath),
    binary,
    native,
    config: await NodeFSP.readFile(configPath),
  };
}

describe("release runner", () => {
  it("keeps absent pinned program inputs pending before invoking fixture preparation", async () => {
    const test = await setup();
    const identity = await test.operations.identity("claude-code", "2.1.303");
    const context = {
      repository: test.options.repository,
      output: test.root,
      runId: "synthetic",
      identity,
    };
    await expect(
      createProcessOperations().packageFixture(context, { artifact: "unused" }),
    ).rejects.toThrow("--bash, --busybox, --ripgrep");
    const missing = createProcessOperations({ bash: NodePath.join(test.root, "missing.wasm") });
    await expect(
      missing.packageFixture(
        { ...context, identity: { ...identity, provider: "codex" } },
        { artifact: "unused" },
      ),
    ).rejects.toBeInstanceOf(PendingReleaseProof);
    expect((await NodeFSP.readdir(test.root)).some((name) => name.startsWith("command-"))).toBe(
      false,
    );
  });

  it("stops a pending scan before packaging or either measurement", async () => {
    const test = await setup();
    test.operations.scan = async () => ({
      status: "pending",
      detail: "Capability baseline missing.",
    });
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("pending");
    expect(result.scan).toEqual({ status: "pending", detail: "Capability baseline missing." });
    expect(result.stages.find((stage) => stage.name === "scan")?.status).toBe("pending");
    expect(test.calls).toEqual(["build", "cleanup"]);
    expect(result.environments).toEqual({});
    await expect(NodeFSP.stat(NodePath.join(test.options.output, "fixture"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("captures a failed subprocess without overwriting an earlier process log", async () => {
    const test = await setup();
    const log = NodePath.join(test.root, "process.log");
    const options = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('failure evidence');process.exitCode=7"],
      cwd: test.root,
      log,
    };
    await expect(runCommand(options)).rejects.toThrow("exit=7");
    expect(await NodeFSP.readFile(log, "utf8")).toBe("failure evidence");
    await expect(runCommand({ ...options, args: ["-e", "process.exitCode=0"] })).rejects.toThrow(
      "EEXIST",
    );
    expect(await NodeFSP.readFile(log, "utf8")).toBe("failure evidence");
  });

  it("strips deployment and inherited probe credentials from children", async () => {
    const test = await setup();
    const log = NodePath.join(test.root, "environment.json");
    await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({account:process.env.CLOUDFLARE_ACCOUNT_ID??null,token:process.env.CLOUDFLARE_API_TOKEN??null,gh:process.env.GH_TOKEN??null,deploy:process.env.HARNESS_RELEASE_DEPLOY??null,url:process.env.PROBE_URL??null,secret:process.env.PROBE_SECRET??null,workerd:process.env.MINIFLARE_WORKERD_PATH??null,keep:process.env.KEEP??null}))",
      ],
      cwd: test.root,
      log,
      purpose: "build",
      environment: {
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "cloudflare-secret",
        GH_TOKEN: "github-secret",
        HARNESS_RELEASE_DEPLOY: "1",
        PROBE_URL: "https://probe.invalid",
        PROBE_SECRET: "probe-secret",
        MINIFLARE_WORKERD_PATH: "/tmp/workerd",
        KEEP: "visible",
      },
    });
    expect(JSON.parse(await NodeFSP.readFile(log, "utf8"))).toEqual({
      account: null,
      token: null,
      gh: null,
      deploy: null,
      url: null,
      secret: null,
      workerd: null,
      keep: "visible",
    });
  });

  it("keeps PROBE_URL absent from local measurement while passing its local secret", async () => {
    const test = await setup();
    const workerd = await installFakeWorkerd(test.options.repository);
    const measure = NodePath.join(
      test.options.repository,
      "apps/cloud/infra/isolateProbe/measure.ts",
    );
    await NodeFSP.mkdir(NodePath.dirname(measure), { recursive: true });
    await NodeFSP.writeFile(
      measure,
      `import * as fs from "node:fs/promises"; const index = process.argv.indexOf("--output"); await fs.writeFile(process.argv[index + 1], JSON.stringify({ url: process.env.PROBE_URL ?? null, secret: process.env.PROBE_SECRET ?? null, token: process.env.CLOUDFLARE_API_TOKEN ?? null, workerd: process.env.MINIFLARE_WORKERD_PATH ?? null }));\n`,
    );
    const previousUrl = process.env.PROBE_URL;
    process.env.PROBE_URL = "https://ambient-probe.invalid";
    try {
      const result = await createProcessOperations().measure(
        {
          repository: test.options.repository,
          output: test.root,
          runId: "synthetic",
          identity: await test.operations.identity("codex", "0.163.0"),
        },
        test.root,
        "local-workerd",
      );
      expect(result).toEqual({
        url: null,
        secret: expect.any(String),
        token: null,
        workerd: workerd.binaryPath,
      });
      const identity = JSON.parse(
        await NodeFSP.readFile(NodePath.join(test.root, "local-workerd-identity.json"), "utf8"),
      );
      expect(identity.wrangler.version).toBe("4.40.0");
      expect(identity.workerd).toEqual({
        native: workerd.native,
        binary: {
          path: workerd.binaryPath,
          bytes: workerd.binary.byteLength,
          sha256: sha256(workerd.binary),
        },
      });
      expect(identity.config).toEqual({
        path: "apps/cloud/infra/isolateProbe/wrangler.jsonc",
        bytes: workerd.config.byteLength,
        sha256: sha256(workerd.config),
      });
      expect(identity.hostInventory.platform).toBe(NodeProcess.platform);
      expect(identity.hostInventory.architecture).toBe(NodeProcess.arch);
    } finally {
      if (previousUrl === undefined) delete process.env.PROBE_URL;
      else process.env.PROBE_URL = previousUrl;
    }
  });

  it("does not measure locally when the installed workerd identity is missing", async () => {
    const test = await setup();
    const measure = NodePath.join(
      test.options.repository,
      "apps/cloud/infra/isolateProbe/measure.ts",
    );
    const marker = NodePath.join(test.root, "measure-ran");
    await NodeFSP.mkdir(NodePath.dirname(measure), { recursive: true });
    await NodeFSP.writeFile(
      measure,
      `import * as fs from "node:fs/promises"; await fs.writeFile(${JSON.stringify(marker)}, "ran");\n`,
    );
    await expect(
      createProcessOperations().measure(
        {
          repository: test.options.repository,
          output: test.root,
          runId: "synthetic",
          identity: await test.operations.identity("codex", "0.163.0"),
        },
        test.root,
        "local-workerd",
      ),
    ).rejects.toThrow();
    await expect(NodeFSP.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      NodeFSP.readFile(NodePath.join(test.root, "local-workerd-identity.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes Cloudflare credentials before runner operations start", () => {
    const environment: NodeJS.ProcessEnv = {
      GITHUB_ACTIONS: "true",
      HARNESS_RELEASE_DEPLOY: "1",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "proof-token",
    };
    expect(takeReleaseDeploymentCredentials(environment)).toEqual({
      enabled: true,
      accountId: "account-id",
      token: "proof-token",
    });
    expect(environment).toEqual({ GITHUB_ACTIONS: "true" });
  });

  it("builds the probe host during the explicit deployment preparation step", async () => {
    const test = await setup();
    const prepared = await prepareProbeHost(test);
    expect(prepared.modules).toHaveLength(10);
    expect(
      await NodeFSP.readFile(
        NodePath.join(prepared.root, "host/generated/childWorkerDispatch.js"),
        "utf8",
      ),
    ).toBe("childWorkerDispatch.js");
    expect(
      await NodeFSP.readFile(NodePath.join(prepared.root, "host/generated/runtime.js"), "utf8"),
    ).toBe("runtime.js");
    expect(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(test.root, "probe-host-inventory.json"), "utf8"),
      ),
    ).toHaveLength(10);
  });

  it("persists deployed version, compatibility, and host binding without the URL or secret", async () => {
    const test = await setup();
    const prepared = await prepareProbeHost(test);
    let uploaded = false;
    const cloud: ReleaseCloudflare = {
      deploy: async (worker) => {
        uploaded = true;
        worker.namespace = "namespace-id";
        worker.version = "version-1";
        return "https://private-probe.invalid";
      },
      request: async (path) => {
        expect(uploaded).toBe(true);
        expect(path).toContain("/settings");
        return {
          compatibility_date: "2026-10-18",
          compatibility_flags: ["nodejs_compat"],
          bindings: [
            { name: "PROBE", namespace_id: "namespace-id" },
            { name: "PROBE_SECRET", text: "never-serialize-this" },
          ],
        };
      },
    };
    const deployed = await deployReleaseProbeHost(
      test.options.repository,
      test.root,
      prepared,
      "deployment-secret",
      { enabled: false },
      cloud,
    );
    const receiptPath = NodePath.join(test.root, "deployment-identity.json");
    const serialized = await NodeFSP.readFile(receiptPath, "utf8");
    const receipt = JSON.parse(serialized);
    const inventoryBytes = await NodeFSP.readFile(
      NodePath.join(test.root, "probe-host-inventory.json"),
    );
    expect(deployed.cloud).toBe(cloud);
    expect(receipt).toEqual({
      schemaVersion: 1,
      script: expect.stringMatching(/^sb-isolate-probe-[a-f0-9]{24}$/u),
      namespace: "namespace-id",
      version: "version-1",
      compatibility: { date: "2026-10-18", flags: ["nodejs_compat"] },
      hostInventory: {
        file: "probe-host-inventory.json",
        moduleCount: 10,
        sha256: sha256(inventoryBytes),
      },
    });
    expect(serialized).not.toContain("private-probe.invalid");
    expect(serialized).not.toContain("deployment-secret");
    expect(serialized).not.toContain("never-serialize-this");
    expect(serialized).not.toContain("PROBE_SECRET");
  });

  it("refuses to upload a probe host whose modules no longer match its inventory", async () => {
    const test = await setup();
    const prepared = await prepareProbeHost(test);
    const modulePath = NodePath.join(prepared.root, "host/generated/worker.js");
    await NodeFSP.chmod(modulePath, 0o644);
    await NodeFSP.writeFile(modulePath, "changed after inventory");
    let uploaded = false;
    const cloud: ReleaseCloudflare = {
      deploy: async () => {
        uploaded = true;
        return "unused";
      },
      request: async () => ({}) as never,
    };
    await expect(
      deployReleaseProbeHost(
        test.options.repository,
        test.root,
        prepared,
        "secret",
        { enabled: false },
        cloud,
      ),
    ).rejects.toThrow("RELEASE_PROBE_HOST_INVENTORY_MISMATCH");
    expect(uploaded).toBe(false);
    await expect(
      NodeFSP.readFile(NodePath.join(test.root, "deployment-identity.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records both deployed version reads and rejects a version change", async () => {
    const test = await setup();
    const script = `sb-isolate-probe-${"a".repeat(24)}`;
    const identity: DeploymentIdentity = {
      schemaVersion: 1,
      script,
      namespace: "namespace-id",
      version: "expected-version",
      compatibility: { date: "2026-10-18", flags: ["nodejs_compat"] },
      hostInventory: {
        file: "probe-host-inventory.json",
        moduleCount: 10,
        sha256: "b".repeat(64),
      },
    };
    await NodeFSP.writeFile(
      NodePath.join(test.root, "deployment-identity.json"),
      JSON.stringify(identity),
    );
    const responses = [
      { deployments: [{ versions: [{ version_id: "expected-version", percentage: 100 }] }] },
      { deployments: [{ versions: [{ version_id: "changed-version", percentage: 100 }] }] },
    ];
    const requests: string[] = [];
    const cloud: ReleaseCloudflare = {
      deploy: async () => "unused",
      request: async (path) => {
        requests.push(path);
        const result = responses.shift();
        if (!result) throw new Error("UNEXPECTED_VERSION_QUERY");
        return result;
      },
    };
    let measureCalls = 0;
    await expect(
      measureWithDeploymentIdentity(test.root, cloud, identity, async () => {
        measureCalls++;
        return "measured";
      }),
    ).rejects.toThrow("RELEASE_DEPLOYMENT_VERSION_CHANGED");
    expect(measureCalls).toBe(1);
    expect(requests).toEqual([
      `/workers/scripts/${script}/deployments`,
      `/workers/scripts/${script}/deployments`,
    ]);
    const before = JSON.parse(
      await NodeFSP.readFile(NodePath.join(test.root, "deployed-active-before.json"), "utf8"),
    );
    const after = JSON.parse(
      await NodeFSP.readFile(NodePath.join(test.root, "deployed-active-after.json"), "utf8"),
    );
    expect(before).toMatchObject({ stage: "before-measure", status: "passed" });
    expect(after).toMatchObject({
      stage: "after-measure",
      status: "failed",
      expectedVersion: "expected-version",
      activeVersions: [{ version: "changed-version", percentage: 100 }],
      error: "RELEASE_DEPLOYMENT_VERSION_CHANGED",
    });
  });

  it("does not measure a deployment with a missing identity receipt", async () => {
    const test = await setup();
    const identity: DeploymentIdentity = {
      schemaVersion: 1,
      script: `sb-isolate-probe-${"c".repeat(24)}`,
      namespace: "namespace-id",
      version: "version-1",
      compatibility: { date: "2026-10-18", flags: ["nodejs_compat"] },
      hostInventory: {
        file: "probe-host-inventory.json",
        moduleCount: 10,
        sha256: "d".repeat(64),
      },
    };
    let queries = 0;
    const cloud: ReleaseCloudflare = {
      deploy: async () => "unused",
      request: async () => {
        queries++;
        return { deployments: [] };
      },
    };
    let measureCalls = 0;
    await expect(
      measureWithDeploymentIdentity(test.root, cloud, identity, async () => {
        measureCalls++;
      }),
    ).rejects.toThrow("RELEASE_DEPLOYMENT_IDENTITY_MISSING");
    expect(queries).toBe(0);
    expect(measureCalls).toBe(0);
  });

  it("keeps a missing Claude release build adapter pending before download", async () => {
    const test = await setup();
    const context = {
      repository: test.options.repository,
      output: test.root,
      runId: "synthetic",
      identity: {
        provider: "claude-code" as const,
        version: "2.1.303",
        upstreamIdentity: "npm:@anthropic-ai/claude-code",
        sha256: "a".repeat(64),
      },
    };
    await expect(createProcessOperations().build(context)).rejects.toBeInstanceOf(
      PendingReleaseProof,
    );
    expect((await NodeFSP.readdir(test.root)).some((name) => name.startsWith("command-"))).toBe(
      false,
    );
  });

  it("keeps six tool results pending and withholds publication under the production verifier", async () => {
    const test = await setup();
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("pending");
    expect(result.publication).toBe("withheld");
    expect(result.unchangedSource).toBe("passed");
    expect(result.environments.deployed?.checks.every((check) => check.status === "pending")).toBe(
      true,
    );
    expect(test.calls).toEqual([
      "build",
      "prepare-deployment",
      "local-workerd",
      "deployed",
      "cleanup",
    ]);
    expect(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(test.options.output, "source-freeze.json"), "utf8"),
      ),
    ).toEqual(result.source);
  });

  it("keeps release outputs outside the source repository", async () => {
    const test = await setup();
    await expect(
      runRelease(
        { ...test.options, output: NodePath.join(test.options.repository, "release-output") },
        test.operations,
      ),
    ).rejects.toThrow("RELEASE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  });

  it("checks source after a failing stage and retains both the failure and source mutation", async () => {
    const test = await setup();
    test.operations.build = async () => {
      await NodeFSP.writeFile(test.source, "per-release workaround");
      throw new Error("BUILD_FAILED_FIRST");
    };
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("red");
    expect(result.unchangedSource).toBe("rejected");
    const stage = result.stages.find((item) => item.name === "build");
    expect(stage?.sourceBefore).not.toBe(stage?.sourceAfter);
    expect(stage?.error).toContain("BUILD_FAILED_FIRST");
    expect(stage?.error).toContain("RELEASE_SOURCE_CHANGED");
    expect(test.calls).toContain("cleanup");
    expect(test.calls).not.toContain("publish");
    expect(
      await NodeFSP.readFile(NodePath.join(test.options.output, "result.json"), "utf8"),
    ).toContain("BUILD_FAILED_FIRST");
  });

  it("refuses an existing output and leaves the first result bytes untouched", async () => {
    const test = await setup();
    await runRelease(test.options, test.operations);
    const file = NodePath.join(test.options.output, "result.json");
    const original = await NodeFSP.readFile(file);
    await expect(runRelease(test.options, test.operations)).rejects.toThrow("EEXIST");
    expect(await NodeFSP.readFile(file)).toEqual(original);
    expect(test.calls.filter((call) => call === "build")).toHaveLength(1);
  });

  it("rejects stale inventory proof and never invokes publication", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    test.operations.measure = async (_context, directory, environment) => {
      const raw = evidence(await freezeFixture(directory), environment);
      return {
        ...raw,
        rows: raw.rows.map((row) => ({
          ...row,
          inventory: row.inventory.map((module) => ({ ...module, sha256: "0".repeat(64) })),
        })),
      };
    };
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("red");
    expect(result.stages.some((stage) => stage.error?.includes("INVENTORY_MISMATCH"))).toBe(true);
    expect(test.calls).not.toContain("publish");
    expect(result.environments).toEqual({});
  });

  it("requires independent local and deployed invocations", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    test.operations.measure = async (_context, directory, environment) => ({
      ...evidence(await freezeFixture(directory), environment),
      runId: "reused-old-invocation",
    });
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("red");
    expect(result.stages.some((stage) => stage.error?.includes("REUSED_RUN_ID"))).toBe(true);
    expect(test.calls).not.toContain("publish");
  });

  it.each(RELEASE_CRITERIA)("requires the %s criterion in each environment", async (name) => {
    const test = await setup();
    test.operations.assess = (_fixture, _raw, environment) => ({
      ...syntheticGreen(),
      checks: syntheticGreen().checks.map((check) =>
        check.name === name && environment === "deployed" ? { ...check, status: "pending" } : check,
      ),
    });
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("pending");
    expect(test.calls).not.toContain("publish");
  });

  it.each(["bootTimeMs", "peakHeapBytes"] as const)("requires measured %s", async (name) => {
    const test = await setup();
    test.operations.assess = () => ({
      ...syntheticGreen(),
      metrics: {
        ...syntheticGreen().metrics,
        [name]: { state: "unmeasured", reason: "Unavailable." },
      },
    });
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("pending");
    expect(test.calls).not.toContain("publish");
  });

  it("allows publication only with a complete synthetic verifier and a successful cleanup", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("green");
    expect(result.publication).toBe("published");
    expect(test.calls.slice(-2)).toEqual(["cleanup", "publish"]);
    expect(result.stages.every((stage) => stage.sourceBefore === stage.sourceAfter)).toBe(true);
  });

  it("withholds publication readiness until a publisher confirms payload publication", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    delete test.operations.publish;
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("green");
    expect(result.publication).toBe("withheld");
  });

  it("rejects fixture mutation during cleanup and still records the cleanup attempt", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    test.operations.cleanup = async (context) => {
      test.calls.push("cleanup");
      await NodeFSP.writeFile(NodePath.join(context.output, "fixture/main.js"), "changed");
    };
    const result = await runRelease(test.options, test.operations);
    const cleanup = result.stages.find((stage) => stage.name === "cleanup");
    expect(test.calls.at(-1)).toBe("cleanup");
    expect(cleanup?.status).toBe("rejected");
    expect(cleanup?.error).toContain("RELEASE_FIXTURE_CHANGED");
    expect(result.status).toBe("red");
    expect(test.calls).not.toContain("publish");
  });

  it("attempts standalone cleanup when its persisted source freeze no longer matches", async () => {
    const test = await setup();
    const run = await runRelease(test.options, test.operations);
    expect(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(test.options.output, "source-freeze.json"), "utf8"),
      ),
    ).toEqual(run.source);
    await NodeFSP.writeFile(test.source, "changed after runner exit");
    let cleanupCalls = 0;
    const evidence = await recoverReleaseCleanup(
      test.options.repository,
      test.options.output,
      async () => {
        cleanupCalls++;
        return "deleted";
      },
    );
    expect(cleanupCalls).toBe(1);
    expect(evidence.status).toBe("failed");
    expect(evidence.sourceBefore.status).toBe("failed");
    expect(evidence.cleanup.status).toBe("deleted");
    expect(evidence.sourceAfter.status).toBe("failed");
    expect(
      (await NodeFSP.readdir(test.options.output)).some(
        (name) => name.startsWith("cleanup-recovery-") && name.endsWith(".json"),
      ),
    ).toBe(true);
  });

  it("checks source again after standalone cleanup mutates it", async () => {
    const test = await setup();
    await runRelease(test.options, test.operations);
    const evidence = await recoverReleaseCleanup(
      test.options.repository,
      test.options.output,
      async () => {
        await NodeFSP.writeFile(test.source, "changed during cleanup");
        return "deleted";
      },
    );
    expect(evidence.sourceBefore.status).toBe("passed");
    expect(evidence.cleanup.status).toBe("deleted");
    expect(evidence.sourceAfter.status).toBe("failed");
    expect(evidence.status).toBe("failed");
  });

  it("records a failed publisher as attempted rather than claiming publication was withheld", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    test.operations.publish = async () => {
      throw new Error("PUBLISH_OUTCOME_UNCONFIRMED");
    };
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("red");
    expect(result.publication).toBe("attempted");
    expect(result.stages.some((stage) => stage.error === "PUBLISH_OUTCOME_UNCONFIRMED")).toBe(true);
  });

  it("retains a missing dependency as pending and makes cleanup failure red", async () => {
    const test = await setup();
    test.operations.packageFixture = async () => {
      throw new PendingReleaseProof("Public dependency is unavailable.");
    };
    test.operations.cleanup = async () => {
      throw new Error("CLEANUP_FAILED");
    };
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("red");
    expect(result.stages.some((stage) => stage.status === "pending")).toBe(true);
    expect(result.stages.some((stage) => stage.error === "CLEANUP_FAILED")).toBe(true);
    expect(test.calls).not.toContain("publish");
  });

  it("never promotes a green backfill and gives a source fix a new candidate identity", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    const first = await runRelease({ ...test.options, selection: "backfill" }, test.operations);
    expect(first.status).toBe("green");
    expect(first.publication).toBe("withheld");
    expect(test.calls).not.toContain("publish");
    await NodeFSP.writeFile(test.source, "export const fixed = true;\n");
    const second = await runRelease(
      { ...test.options, selection: "backfill", output: NodePath.join(test.root, "retry") },
      test.operations,
    );
    expect(second.runKey).toBe(first.runKey);
    expect(second.candidateId).not.toBe(first.candidateId);
    expect(second.artifact?.sha256).toBe(first.artifact?.sha256);
  });

  it("detects artifact or fixture mutation even when measurement throws", async () => {
    const test = await setup();
    test.operations.assess = syntheticGreen;
    test.operations.measure = async (context, fixture) => {
      await NodeFSP.writeFile(NodePath.join(context.output, "artifact/engine.wasm"), "tampered");
      await NodeFSP.writeFile(NodePath.join(fixture, "main.js"), "changed fixture");
      throw new Error("MEASUREMENT_FAILED");
    };
    const result = await runRelease(test.options, test.operations);
    expect(result.status).toBe("red");
    expect(result.stages.some((stage) => stage.error?.includes("FIXTURE_CHANGED"))).toBe(true);
    expect(
      result.stages.some((stage) => stage.error?.includes("ARTIFACT_INVENTORY_MISMATCH")),
    ).toBe(true);
    expect(test.calls).toContain("cleanup");
    expect(test.calls).not.toContain("publish");
  });
});
