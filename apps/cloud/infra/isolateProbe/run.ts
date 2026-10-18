// @effect-diagnostics nodeBuiltinImport:off - coordinate the existing Alchemy and measurement CLIs.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { runProcess, type RunProcess } from "./process.ts";

const cloudDir = NodePath.resolve(import.meta.dirname, "../..");
const stack = "infra/isolateProbe/alchemy.run.ts";
const isolatedStage = /^isolate-probe-[a-f0-9]{8,20}$/;

export function probeUrl(output: string, stage: string) {
  const urls = [...output.matchAll(/\burl:\s*(['"])(https:\/\/[^'"\s]+)\1/gu)];
  const value = urls.at(-1)?.[2];
  if (!value) throw new Error("Alchemy output did not contain the probe Worker URL.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.hostname.split(".")[0] !== `sb-${stage}` ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Alchemy returned a URL outside the isolated probe Worker.");
  return url.toString();
}

interface RunOptions {
  fixture?: string;
  output?: string;
  signal?: AbortSignal;
  destroyStage?: string;
}

export async function runProbe(
  options: RunOptions,
  dependencies: {
    run?: RunProcess;
    log?: (message: string) => void;
    evidence?: (json: string) => void;
  } = {},
) {
  const run = dependencies.run ?? runProcess;
  const log = dependencies.log ?? ((message) => process.stderr.write(`${message}\n`));
  const stage =
    options.destroyStage ?? `isolate-probe-${NodeCrypto.randomBytes(8).toString("hex")}`;
  if (!isolatedStage.test(stage)) throw new Error("Expected an exact isolate-probe-<hex> stage.");
  const secret = NodeCrypto.randomBytes(32).toString("base64url");
  const env: NodeJS.ProcessEnv = { ...process.env, PROBE_SECRET: secret };
  // Never let an ambient shared endpoint choose which Worker receives this run's credential.
  delete env.PROBE_URL;
  const alchemy = (action: "deploy" | "destroy") =>
    run({
      command: NodePath.join(cloudDir, "node_modules/.bin/alchemy"),
      args: [action, stack, "--stage", stage, "--yes", "--no-input"],
      cwd: cloudDir,
      env,
      timeoutMs: action === "destroy" ? 120_000 : 600_000,
      ...(action === "deploy" && options.signal ? { signal: options.signal } : {}),
    });
  const destroy = async () => {
    const result = await alchemy("destroy");
    if (result.code !== 0) throw new Error(`Probe cleanup exited ${result.code}.`);
    log(`Destroyed ${stage}.`);
  };
  log(`Probe stage ${stage}.`);
  const recovery = () =>
    log(
      `Cleanup failed for ${stage}. Recover from this checkout with: node apps/cloud/infra/isolateProbe/run.ts --destroy-stage ${stage}`,
    );
  if (options.destroyStage) {
    try {
      await destroy();
    } catch (error) {
      recovery();
      throw error;
    }
    return stage;
  }
  let primary: unknown;
  let failed = false;
  try {
    const deployment = await alchemy("deploy");
    if (deployment.code !== 0) throw new Error(`Probe deployment exited ${deployment.code}.`);
    const url = probeUrl(deployment.stdout, stage);
    const measurement = await run({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        NodePath.join(import.meta.dirname, "measure.ts"),
        ...(options.fixture ? ["--fixture", NodePath.resolve(options.fixture)] : []),
        ...(options.output ? ["--output", NodePath.resolve(options.output)] : []),
      ],
      cwd: cloudDir,
      env: { ...env, PROBE_URL: url },
      timeoutMs: 600_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!options.output) {
      const safe = measurement.stdout
        .replaceAll(secret, "[credential]")
        .replaceAll(new URL(url).host, "[probe]");
      (dependencies.evidence ?? ((json) => process.stdout.write(json)))(safe);
    }
    if (measurement.code !== 0) throw new Error(`Probe measurement exited ${measurement.code}.`);
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    try {
      await destroy();
    } catch (error) {
      recovery();
      if (!failed) {
        failed = true;
        primary = error;
      }
    }
  }
  if (failed) throw primary;
  if (options.signal?.aborted) throw new Error("Probe run interrupted.");
  return stage;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(import.meta.filename)
) {
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal;
    controller.abort();
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    const { values } = NodeUtil.parseArgs({
      options: {
        fixture: { type: "string" },
        output: { type: "string" },
        "destroy-stage": { type: "string" },
      },
    });
    if (values["destroy-stage"] && (values.fixture || values.output))
      throw new Error("Recovery accepts only --destroy-stage.");
    await runProbe({
      ...(values.fixture ? { fixture: values.fixture } : {}),
      ...(values.output ? { output: values.output } : {}),
      ...(values["destroy-stage"] ? { destroyStage: values["destroy-stage"] } : {}),
      signal: controller.signal,
    });
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Probe run failed."}\n`);
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}
