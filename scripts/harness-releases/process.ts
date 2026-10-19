import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ClaudeReleaseInventory } from "../claude-bunfs/release-inventory.ts";
import { object, sha256 } from "./fixture.ts";
import { compareReleaseScan } from "../claude-bunfs/scan-release.ts";
import {
  cleanupReleaseDeployment,
  deployReleaseProbeHost,
  measureWithDeploymentIdentity,
  prepareReleaseProbeHost,
  type ReleaseDeploymentCredentials,
  type PreparedProbeHost,
  type DeployedProbeHost,
} from "./deployment.ts";
import { codexBuildPin, resolveOfficialRelease } from "./releaseIdentity.ts";
import { captureLocalWorkerdIdentity } from "./runtimeIdentity.ts";
import {
  PendingReleaseProof,
  writeOnce,
  type ReleaseBuild,
  type ReleaseContext,
  type ReleaseOperations,
  type ScanAssessment,
} from "./runner.ts";
import { isNodeErrorCode } from "./guards.ts";

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(path, "utf8"));

type CommandPurpose = "build" | "scan" | "package" | "measure" | "prepare-deployment";
const protectedChildVariables = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "HARNESS_RELEASE_DEPLOY",
  "MINIFLARE_WORKERD_PATH",
  "PROBE_URL",
  "PROBE_SECRET",
] as const;

function childEnvironment(
  purpose: CommandPurpose,
  supplied: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...supplied };
  for (const name of protectedChildVariables) delete environment[name];
  if (purpose === "measure") {
    if (supplied?.PROBE_SECRET) environment.PROBE_SECRET = supplied.PROBE_SECRET;
    if (supplied?.MINIFLARE_WORKERD_PATH)
      environment.MINIFLARE_WORKERD_PATH = supplied.MINIFLARE_WORKERD_PATH;
  }
  return environment;
}

/** Logs stay in the private run directory; arguments never contain deployment credentials. */
export async function runCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  log: string;
  purpose?: CommandPurpose;
  environment?: Record<string, string>;
}) {
  const log = await NodeFSP.open(options.log, "wx", 0o600);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = NodeChildProcess.spawn(options.command, options.args, {
        cwd: options.cwd,
        env: childEnvironment(options.purpose ?? "build", options.environment),
        stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (exit !== 0)
      throw new Error(`RELEASE_COMMAND_FAILED: ${NodePath.basename(options.log)} exit=${exit}`);
  } finally {
    await log.close();
  }
}

function checkSummary(report: unknown): ScanAssessment {
  const checks = object(object(report).checks);
  const names = [
    "extraction",
    "inventory",
    "builtinGaps",
    "bunCapabilities",
    "codegen",
    "rebundle",
  ];
  const states = names.map((name) => object(checks[name]).status);
  return {
    status: states.includes("fail")
      ? "rejected"
      : states.every((state) => state === "pass")
        ? "passed"
        : "pending",
    detail: names.map((name, index) => `${name}=${String(states[index])}`).join(", "),
  };
}

function parseClaudeReleaseInventory(value: unknown): ClaudeReleaseInventory {
  const input = object(value);
  const release = object(input.release);
  const binary = object(input.binary);
  const graph = object(input.graph);
  const modules = object(input.modules);
  const bunApis = object(input.bunApis);
  const invalid = (): never => {
    throw new Error("CLAUDE_RELEASE_INVENTORY_INVALID");
  };
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new Error("CLAUDE_RELEASE_INVENTORY_INVALID");
    return value;
  };
  const nonNegativeInteger = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const builtins = array(input.builtins);
  const napiModules = array(input.napiModules);
  const codegenFindings = array(input.codegenFindings);
  const builtinGaps = array(input.builtinGaps);
  const bunCapabilityGaps = array(input.bunCapabilityGaps);
  const unresolvedReferences = array(input.unresolvedReferences);
  const unresolvedBareReferences = array(input.unresolvedBareReferences);
  const bunApiMembers = array(bunApis.members);
  const bunApiDynamicAccesses = array(bunApis.dynamicAccesses);
  if (
    input.schemaVersion !== 1 ||
    typeof release.version !== "string" ||
    !release.version ||
    typeof release.platform !== "string" ||
    !release.platform ||
    (release.bunVersion !== null && typeof release.bunVersion !== "string") ||
    !nonNegativeInteger(binary.bytes) ||
    typeof binary.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(binary.sha256) ||
    !nonNegativeInteger(graph.entry) ||
    !nonNegativeInteger(graph.flags) ||
    !nonNegativeInteger(graph.recordSize) ||
    ![
      "count",
      "bytes",
      "javascriptCount",
      "javascriptBytes",
      "reachableCount",
      "reachableJavascriptCount",
      "reachableJavascriptBytes",
    ].every((name) => nonNegativeInteger(modules[name]))
  )
    invalid();

  for (const member of bunApiMembers) {
    const item = object(member);
    if (typeof item.path !== "string" || !item.path) invalid();
  }
  for (const item of builtins) {
    const builtin = object(item);
    const imports = array(builtin.imports);
    const memberUses = array(builtin.memberUses);
    const dynamicMemberUses = array(builtin.dynamicMemberUses);
    if (typeof builtin.canonicalBuiltin !== "string") invalid();
    for (const entry of imports) {
      const imported = object(entry);
      if (typeof imported.kind !== "string" || typeof imported.imported !== "string") invalid();
    }
    for (const entry of memberUses) {
      const use = object(entry);
      if (typeof use.via !== "string" || typeof use.member !== "string") invalid();
    }
    for (const entry of dynamicMemberUses) {
      if (typeof object(entry).via !== "string") invalid();
    }
  }
  for (const item of napiModules) {
    if (typeof object(item).key !== "string") invalid();
  }
  for (const item of codegenFindings) {
    const finding = object(item);
    if (
      typeof finding.kind !== "string" ||
      typeof finding.operation !== "string" ||
      (finding.literal !== undefined && typeof finding.literal !== "string")
    )
      invalid();
  }
  for (const raw of [...builtinGaps, ...bunCapabilityGaps]) {
    const gap = object(raw);
    if (
      (gap.kind !== "bun-api" && gap.kind !== "node-builtin") ||
      typeof gap.name !== "string" ||
      typeof gap.module !== "string" ||
      typeof gap.reason !== "string" ||
      typeof gap.guarded !== "boolean" ||
      !nonNegativeInteger(gap.offset)
    )
      invalid();
    if (gap.kind === "node-builtin" && typeof gap.canonicalBuiltin !== "string") invalid();
  }
  for (const raw of [...unresolvedReferences, ...unresolvedBareReferences]) {
    const reference = object(raw);
    if (
      typeof reference.module !== "string" ||
      typeof reference.kind !== "string" ||
      typeof reference.specifier !== "string"
    )
      invalid();
  }
  for (const raw of bunApiDynamicAccesses) object(raw);
  return input as unknown as ClaudeReleaseInventory;
}

export function createProcessOperations(
  options: {
    baseline?: string;
    bash?: string;
    busybox?: string;
    ripgrep?: string;
    deploymentCredentials?: ReleaseDeploymentCredentials;
  } = {},
): ReleaseOperations {
  let sequence = 0;
  let deployedHost: DeployedProbeHost | undefined;
  let preparedHost: PreparedProbeHost | undefined;
  const secret = NodeCrypto.randomBytes(32).toString("base64url");
  const command = (
    context: ReleaseContext,
    executable: string,
    args: string[],
    purpose: CommandPurpose = "build",
    environment?: Record<string, string>,
  ) =>
    runCommand({
      command: executable,
      args,
      cwd: context.repository,
      log: NodePath.join(context.output, `command-${++sequence}.log`),
      purpose,
      ...(environment ? { environment } : {}),
    });
  const node = (
    context: ReleaseContext,
    args: string[],
    purpose: CommandPurpose = "build",
    environment?: Record<string, string>,
  ) => command(context, process.execPath, args, purpose, environment);
  return {
    identity: (provider, version) =>
      resolveOfficialRelease(provider, version, (url) =>
        fetch(url, {
          signal: AbortSignal.timeout(60_000),
          headers:
            url.startsWith("https://api.github.com/") && process.env.GH_TOKEN
              ? { authorization: `Bearer ${process.env.GH_TOKEN}` }
              : {},
        }),
      ),
    async build(context) {
      const { identity, repository, output } = context;
      if (identity.provider === "claude-agent-sdk")
        throw new PendingReleaseProof("The Agent SDK release build adapter is not available.");
      if (identity.provider === "claude-code") {
        const adapter = NodePath.join(repository, "scripts/harness-releases/buildClaude.ts");
        const available = await NodeFSP.lstat(adapter).then(
          (stat) => stat.isFile(),
          (error: unknown) => {
            if (isNodeErrorCode(error, "ENOENT")) return false;
            throw error;
          },
        );
        if (!available)
          throw new PendingReleaseProof("The Claude Code release build adapter is not available.");
      }
      if (identity.provider === "codex") {
        if (!identity.codex) throw new Error("RELEASE_CODEX_IDENTITY_REQUIRED");
        const pin = codexBuildPin(
          await json(NodePath.join(repository, "native/codex-wasm/upstream.json")),
          identity,
        );
        const pinFile = NodePath.join(output, "codex-pin.json");
        await writeOnce(pinFile, pin);
        const build = NodePath.join(output, "codex-build");
        await command(context, "python3.11", [
          "native/codex-wasm/build.py",
          "--pin",
          pinFile,
          "--target",
          "wasm32-wasip1",
          "--cache",
          NodePath.join(output, "codex-cache"),
          "--output",
          build,
        ]);
        return {
          artifact: NodePath.join(
            build,
            `${identity.version}-${identity.codex.commit.slice(0, 12)}`,
            "wasm32-wasip1/artifact",
          ),
        };
      }
      const download = NodePath.join(output, "download");
      await node(context, [
        "scripts/claude-bunfs/releases.ts",
        download,
        identity.version,
        "linux-x64",
      ]);
      const extracted = NodePath.join(download, `graph-${identity.version}-linux-x64`);
      const release = object(await json(NodePath.join(extracted, ".bun-data/release.json")));
      if (sha256(JSON.stringify(release.manifest)) !== identity.binary?.manifestSha256)
        throw new Error("RELEASE_OFFICIAL_MANIFEST_CHANGED");
      const artifact = NodePath.join(output, "claude-artifact");
      await node(context, [
        "scripts/harness-releases/buildClaude.ts",
        "--identity",
        NodePath.join(output, "identity.json"),
        "--extracted",
        extracted,
        "--output",
        artifact,
        "--result",
        NodePath.join(output, "claude-build.json"),
      ]);
      return { artifact, extracted };
    },
    async scan(context, built) {
      if (context.identity.provider === "codex") {
        const manifest = object(await json(NodePath.join(built.artifact, "manifest.json")));
        if (
          manifest.version !== context.identity.version ||
          manifest.upstreamCommit !== context.identity.codex?.commit ||
          manifest.target !== "wasm32-wasip1"
        )
          throw new Error("RELEASE_CODEX_ARTIFACT_MISMATCH");
        const bytes = await NodeFSP.readFile(NodePath.join(built.artifact, "engine.wasm"));
        if (manifest.moduleSha256 !== sha256(bytes) || manifest.moduleBytes !== bytes.length)
          throw new Error("RELEASE_CODEX_MODULE_MISMATCH");
        await writeOnce(NodePath.join(context.output, "inventory.json"), manifest);
        const baseline = options.baseline ? object(await json(options.baseline)) : undefined;
        await writeOnce(NodePath.join(context.output, "inventory-diff.json"), {
          baseline: baseline ?? null,
          candidate: manifest,
          importsChanged: baseline
            ? JSON.stringify(baseline.imports) !== JSON.stringify(manifest.imports)
            : null,
          exportsChanged: baseline
            ? JSON.stringify(baseline.exports) !== JSON.stringify(manifest.exports)
            : null,
        });
        return {
          status: "pending",
          detail:
            "Codex import inventory is recorded. A validated builtin capability scanner is required.",
        };
      }
      const result = object(await json(NodePath.join(context.output, "claude-build.json")));
      const report = object(result.report);
      const inventory = object(report.inventory);
      await writeOnce(NodePath.join(context.output, "inventory.json"), inventory);
      if (options.baseline) {
        const baseline = NodePath.join(context.output, "baseline-inventory.json");
        await writeOnce(baseline, await json(options.baseline));
        const diff = compareReleaseScan(
          parseClaudeReleaseInventory(await json(baseline)),
          parseClaudeReleaseInventory(inventory),
        );
        await writeOnce(NodePath.join(context.output, "inventory-diff.json"), diff);
        if (Array.isArray(diff.newUnguardedNames) && diff.newUnguardedNames.length)
          return {
            status: "rejected",
            detail: "New unguarded APIs were found in the release inventory diff.",
          };
      } else {
        await writeOnce(NodePath.join(context.output, "inventory-diff.json"), {
          status: "pending",
          reason: "No baseline inventory was supplied.",
        });
      }
      const summary = checkSummary(report);
      return !options.baseline && summary.status === "passed"
        ? {
            status: "pending",
            detail: "The scanner passed; the prior release inventory is required for the diff.",
          }
        : summary;
    },
    async packageFixture(context, built: ReleaseBuild) {
      const fixture = NodePath.join(context.output, "fixture");
      const required =
        context.identity.provider === "codex"
          ? (["bash"] as const)
          : (["bash", "busybox", "ripgrep"] as const);
      const missing = required.filter((name) => !options[name]);
      if (missing.length)
        throw new PendingReleaseProof(
          `Mock-model packaging requires pinned program inputs: ${missing.map((name) => `--${name}`).join(", ")}.`,
        );
      const programs: Partial<Record<"bash" | "busybox" | "ripgrep", string>> = {};
      const programInventory = [];
      await NodeFSP.mkdir(NodePath.join(context.output, "programs"));
      for (const name of required) {
        const input = options[name];
        if (!input) throw new PendingReleaseProof(`Missing --${name}.`);
        const bytes = await NodeFSP.readFile(input).catch((error: unknown) => {
          if (isNodeErrorCode(error, "ENOENT"))
            throw new PendingReleaseProof(`The --${name} program input is unavailable.`);
          throw error;
        });
        const target = NodePath.join(context.output, "programs", `${name}.wasm`);
        await NodeFSP.writeFile(target, bytes, { flag: "wx", mode: 0o444 });
        programs[name] = target;
        programInventory.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
      }
      await writeOnce(NodePath.join(context.output, "program-inputs.json"), programInventory);
      if (context.identity.provider === "codex") {
        const manifest = await NodeFSP.readFile(NodePath.join(built.artifact, "manifest.json"));
        await node(
          context,
          [
            "apps/cloud/infra/codexTurn/prepareFixture.mjs",
            built.artifact,
            sha256(manifest),
            NodePath.join(context.repository, "apps/cloud/src/kernel"),
            fixture,
            "turn",
            programs.bash!,
          ],
          "package",
        );
      } else {
        const available = await NodeFSP.stat(
          NodePath.join(
            context.repository,
            "apps/cloud/infra/claudeTurnProof/prepareProgramModules.ts",
          ),
        ).then(
          (stat) => stat.isFile(),
          (error: unknown) => {
            if (isNodeErrorCode(error, "ENOENT")) return false;
            throw error;
          },
        );
        if (!available)
          throw new PendingReleaseProof(
            "Claude mock-model packaging requires the accepted kernel program adapter from PR #1219.",
          );
        await node(
          context,
          [
            "apps/cloud/infra/claudeTurnProof/prepare.ts",
            "--release",
            built.artifact,
            "--output",
            fixture,
            "--seed-assets",
            "--scenario",
            "tools",
            "--bash",
            programs.bash!,
            "--busybox",
            programs.busybox!,
            "--ripgrep",
            programs.ripgrep!,
          ],
          "package",
        );
      }
      return fixture;
    },
    async prepareDeployment(context) {
      await node(context, ["apps/cloud/infra/isolateProbe/prepare.ts"], "prepare-deployment");
      preparedHost = await prepareReleaseProbeHost(context.repository, context.output);
    },
    async measure(context, fixture, environment) {
      const destination = NodePath.join(context.output, `raw-${environment}.json`);
      const args = [
        "apps/cloud/infra/isolateProbe/measure.ts",
        "--fixture",
        fixture,
        "--output",
        destination,
        "--measure-only",
      ];
      if (environment === "deployed") {
        if (!preparedHost) throw new Error("RELEASE_PROBE_HOST_NOT_PREPARED");
        deployedHost = await deployReleaseProbeHost(
          context.repository,
          context.output,
          preparedHost,
          secret,
          options.deploymentCredentials ?? { enabled: false },
        );
        if (process.env.GITHUB_ACTIONS === "true")
          process.stdout.write(
            `::add-mask::${deployedHost.url}\n::add-mask::${new URL(deployedHost.url).host}\n`,
          );
        args.push("--url", deployedHost.url);
      }
      const measure = (environmentVariables: Record<string, string>) =>
        node(context, args, "measure", environmentVariables);
      if (environment === "local-workerd") {
        const identity = await captureLocalWorkerdIdentity(context.repository);
        await writeOnce(NodePath.join(context.output, "local-workerd-identity.json"), identity);
        await measure({
          PROBE_SECRET: secret,
          MINIFLARE_WORKERD_PATH: identity.workerd.binary.path,
        });
      } else {
        if (!deployedHost) throw new Error("RELEASE_DEPLOYMENT_IDENTITY_MISSING");
        await measureWithDeploymentIdentity(
          context.output,
          deployedHost.cloud,
          deployedHost.identity,
          () => measure({ PROBE_SECRET: secret }),
        );
      }
      return json(destination);
    },
    async cleanup(context) {
      const disposition = await cleanupReleaseDeployment(
        context.repository,
        context.output,
        options.deploymentCredentials ?? { enabled: false },
      );
      if (disposition === "deleted") {
        const owner = object(await json(NodePath.join(context.output, "owned-worker.json")));
        await writeOnce(NodePath.join(context.output, "deployment-cleanup.json"), {
          script: owner.script,
          deleted: true,
        });
      }
    },
  };
}
