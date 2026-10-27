// @effect-diagnostics nodeBuiltinImport:off - coordinate the existing Alchemy and measurement CLIs.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { diagnostics, runProcess, type RunProcess } from "./process.ts";
import { waitForProbeRouter } from "./readiness.ts";
import { isolatedStage, stageFile } from "./stageFile.ts";

const cloudDir = NodePath.resolve(import.meta.dirname, "../..");
const stack = "infra/isolateProbe/alchemy.run.ts";

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
  stageFile?: string;
  recoverStageFile?: string;
}

export async function runProbe(
  options: RunOptions,
  dependencies: {
    run?: RunProcess;
    log?: (message: string) => void;
    evidence?: (json: string) => void;
    routerReady?: typeof waitForProbeRouter;
  } = {},
) {
  const run = dependencies.run ?? runProcess;
  const log = dependencies.log ?? ((message) => process.stderr.write(`${message}\n`));
  if (options.recoverStageFile) {
    const claim = await stageFile(options.recoverStageFile);
    try {
      if (claim.cleanupFailed) {
        throw new Error(
          `Cleanup already failed for ${claim.stage}. Recover manually: node apps/cloud/infra/isolateProbe/run.ts --destroy-stage ${claim.stage}`,
        );
      }
      return await runProbe(
        { destroyStage: claim.stage, stageFile: options.recoverStageFile },
        dependencies,
      );
    } finally {
      await claim.close();
    }
  }
  const stage =
    options.destroyStage ?? `isolate-probe-${NodeCrypto.randomBytes(8).toString("hex")}`;
  if (!isolatedStage.test(stage)) throw new Error("Expected an exact isolate-probe-<hex> stage.");
  const claim = options.stageFile
    ? await stageFile(options.stageFile, options.destroyStage ? undefined : stage)
    : undefined;
  try {
    if (claim && (claim.stage !== stage || claim.cleanupFailed))
      throw new Error(
        `Stage file does not authorize automatic cleanup for ${stage}. Recover manually without --stage-file.`,
      );
    const secret = NodeCrypto.randomBytes(32).toString("base64url");
    const env: NodeJS.ProcessEnv = { ...process.env, PROBE_SECRET: secret };
    // Never let an ambient shared endpoint choose which Worker receives this run's credential.
    delete env.PROBE_URL;
    const failure = (phase: string, result: Awaited<ReturnType<RunProcess>>) =>
      new Error(
        `Probe ${phase} exited ${result.code}.\n${diagnostics(result.stdout, result.stderr, env)}`,
      );
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
      try {
        const result = await alchemy("destroy");
        if (result.code !== 0) throw failure("cleanup", result);
        await claim?.remove();
        log(`Destroyed ${stage}.`);
      } catch (error) {
        try {
          await claim?.markFailed();
        } catch {
          log(`Could not record cleanup failure for ${stage}; retain the manual recovery command.`);
        }
        throw error;
      }
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
      if (deployment.code !== 0) throw failure("deployment", deployment);
      const url = probeUrl(deployment.stdout, stage);
      const routerReady = dependencies.routerReady ?? waitForProbeRouter;
      await routerReady(url, secret, {
        ...(options.signal ? { signal: options.signal } : {}),
        onPending: (reason) => log(`Probe setup pending: ${reason}.`),
      });
      if (options.signal?.aborted) throw new Error("Probe run interrupted.");
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
      if (measurement.code !== 0) throw failure("measurement", measurement);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      try {
        await destroy();
      } catch (error) {
        log(error instanceof Error ? error.message : "Probe cleanup failed.");
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
  } finally {
    await claim?.close();
  }
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
        "stage-file": { type: "string" },
        "recover-stage-file": { type: "string" },
      },
    });
    if (values["destroy-stage"] && (values.fixture || values.output))
      throw new Error("Recovery accepts only --destroy-stage.");
    if (values["recover-stage-file"] && Object.values(values).filter(Boolean).length !== 1)
      throw new Error("Recovery accepts only --recover-stage-file.");
    await runProbe({
      ...(values.fixture ? { fixture: values.fixture } : {}),
      ...(values.output ? { output: values.output } : {}),
      ...(values["destroy-stage"] ? { destroyStage: values["destroy-stage"] } : {}),
      ...(values["stage-file"] ? { stageFile: values["stage-file"] } : {}),
      ...(values["recover-stage-file"] ? { recoverStageFile: values["recover-stage-file"] } : {}),
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
