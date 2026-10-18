// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - CI controls run the frozen Node CLI and native HTTP.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import { json, record, writeJson } from "./ciArchive.ts";
import type { Cloudflare, OwnedWorker } from "./ciCloudflare.ts";
import { captureProfile, redact } from "./ciProfile.ts";
import { startCold, rootTraffic } from "./ciRequests.ts";

export function classify(evidence: unknown): "oom" | "cwd44" | "other" {
  const encoded = JSON.stringify(evidence);
  if (
    /out of memory|isolate exhausted memory|memory limit|exceeded[^"\n]*memory|\boom\b/i.test(
      encoded,
    )
  )
    return "oom";
  try {
    const rows = record(evidence).rows;
    if (!Array.isArray(rows) || rows.length !== 1) return "other";
    const row = record(rows[0]);
    const result = record(record(row.response).result);
    if (
      row.cold === true &&
      row.path === "/startup" &&
      result.ok === false &&
      result.exit === 1 &&
      /set engine working directory/i.test(String(result.stderr)) &&
      /os error 44/.test(String(result.stderr))
    )
      return "cwd44";
  } catch {
    return "other";
  }
  return "other";
}

export interface ControlDependencies {
  cold: typeof startCold;
  profile: typeof captureProfile;
  traffic: typeof rootTraffic;
}

export async function discoverActiveActor(
  cloud: Cloudflare,
  owner: OwnedWorker,
  cold: Promise<unknown>,
  wait = async (signal: AbortSignal) => {
    await NodeTimersPromises.setTimeout(2000, undefined, { signal });
  },
) {
  const observations: object[] = [];
  for (let phase = 0; phase < 3; phase++) {
    const actor = await cloud.actor(owner);
    observations.push({ phase, state: actor ? "root-created" : "root-not-yet-visible" });
    if (actor) return { actor, observations };
    // While the one cold request is advancing, observe at most two more discovery
    // windows. A completed request switches to post-request capture, never a startup retry.
    if (phase === 2) break;
    const controller = new AbortController();
    try {
      const finished = await Promise.race([
        cold.then(() => true),
        wait(controller.signal).then(() => false),
      ]);
      if (finished) break;
    } finally {
      controller.abort();
    }
  }
  return { actor: undefined, observations };
}

export const successfulControls = (results: Record<string, unknown>[]) =>
  results.length === 5 &&
  results.every(
    (result) => result.classification === "cwd44" && result.exit === 1 && !result.cleanupError,
  ) &&
  results.some((result) => result.profileValid === true);

export async function runControls(
  cloud: Cloudflare,
  root: string,
  modules: Record<string, unknown>[],
  secret: string,
  output: string,
  scratch: string,
  ledger: string,
  dependencies: ControlDependencies = {
    cold: startCold,
    profile: captureProfile,
    traffic: rootTraffic,
  },
) {
  const workers: OwnedWorker[] = [];
  const results: Record<string, unknown>[] = [];
  const secrets = [secret, cloud.token, process.env.GH_TOKEN ?? ""];
  for (let index = 1; index <= 5; index++) {
    const owner: OwnedWorker = {
      script: `sb-isolate-probe-${NodeCrypto.randomBytes(12).toString("hex")}`,
    };
    workers.push(owner);
    await writeJson(ledger, workers);
    const dir = NodePath.join(output, `control-${index}`);
    await NodeFSP.mkdir(dir, { recursive: true });
    const result: Record<string, unknown> = {
      index,
      script: owner.script,
      classification: "other",
      profileValid: false,
    };
    let cold: ReturnType<typeof startCold> | undefined;
    try {
      const url = await cloud.deploy(owner, root, modules, secret);
      process.stdout.write(`::add-mask::${new URL(url).host}\n::add-mask::${url}\n`);
      secrets.push(url, new URL(url).host);
      await writeJson(ledger, workers);
      const coldOutput = NodePath.join(scratch, `control-${index}.json`);
      cold = dependencies.cold(root, url, coldOutput, secret);
      let coldFinished = false;
      void cold.then(
        () => {
          coldFinished = true;
        },
        () => {
          coldFinished = true;
        },
      );
      const discovery = await discoverActiveActor(cloud, owner, cold).catch(() => ({
        actor: undefined,
        observations: [{ state: "discovery-api-failed" }],
      }));
      const activeActor = coldFinished ? undefined : discovery.actor;
      await writeJson(NodePath.join(dir, "actor-discovery.json"), discovery.observations);
      await writeJson(ledger, workers);
      let profileError: string | undefined;
      if (activeActor) {
        try {
          result.profileValid = await dependencies.profile(
            cloud,
            owner,
            dir,
            scratch,
            "during-cold-request",
            secrets,
          );
        } catch (error) {
          profileError = redact(String(error), secrets);
        }
      }
      const invocation = await cold;
      let evidence: unknown;
      try {
        evidence = await json(coldOutput);
      } catch {
        evidence = { error: "Cold CLI did not produce JSON evidence" };
      }
      result.classification = classify(evidence);
      result.exit = invocation.exit;
      await NodeFSP.writeFile(
        NodePath.join(dir, "cold.json"),
        redact(JSON.stringify({ evidence, invocation }, null, 2), secrets),
      );
      if (!activeActor) {
        const actor = await cloud.actor(owner);
        await writeJson(ledger, workers);
        if (!actor) throw new Error("No root actor after cold request");
        const runId = record(evidence).runId;
        if (typeof runId !== "string" || !/^[a-f0-9]{16}$/.test(runId))
          throw new Error("Missing frozen CLI session ID");
        const session = `${runId}-1069-startup-r4-wasi-r4`;
        // Reuse the original root only after the cold outcome. Never restart /startup.
        let active = true;
        const traffic = dependencies.traffic(url, session, secret, () => active);
        try {
          result.profileValid = await dependencies.profile(
            cloud,
            owner,
            dir,
            scratch,
            "after-cold-request",
            secrets,
          );
        } finally {
          active = false;
          await traffic;
        }
      }
      if (profileError) result.profileError = profileError;
    } catch (error) {
      result.error = redact(String(error), secrets);
    } finally {
      // Even deployment/profile failures cannot overlap two cold controls.
      await cold?.catch(() => {});
      try {
        await cloud.cleanup(owner);
      } catch (error) {
        result.cleanupError = redact(String(error), secrets);
      }
      // Persist the complete ownership set, including partial uploads, for the always step.
      await writeJson(ledger, workers);
      const receipt = NodePath.join(dir, "profile-receipt.json");
      if (!(await NodeFSP.stat(receipt).catch(() => undefined))) {
        const failed = {
          valid: false,
          httpStatus: null,
          scope: "supervisor-only",
          error: result.error ?? result.profileError ?? "No profile target available",
        };
        await writeJson(receipt, failed);
        await writeJson(NodePath.join(dir, "profile-error.json"), failed);
      }
      await writeJson(NodePath.join(dir, "result.json"), { ...result, owner });
      results.push(result);
      await writeJson(NodePath.join(output, "summary.json"), {
        sourcePin: "002c311a136766f1ebc7be7ad65f5143667f5ffa",
        controlsRequested: 5,
        controlsCompleted: results.length,
        oomCount: results.filter((r) => r.classification === "oom").length,
        actualCwd44Count: results.filter((r) => r.classification === "cwd44").length,
        validColdOutcomes: results.filter((r) => r.classification !== "other").length,
        oomFrequency:
          results.length === 5 && results.every((r) => r.classification !== "other")
            ? results.filter((r) => r.classification === "oom").length / 5
            : null,
        limitation:
          "Profiles target the supervisor, not a proven dynamic child, and miss already-loaded startup allocations.",
        results,
      });
    }
  }
  return results;
}
