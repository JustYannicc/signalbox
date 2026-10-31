import type { BundleOutput } from "alchemy/Bundle/Bundle";
import { describe, expect, it } from "vite-plus/test";
import { requireStartupEvidence } from "./evidence.ts";
import { sha256, startupPayload, serializeStartupPayload } from "./payload.ts";

const bundle: BundleOutput = {
  hash: "unused-by-gate",
  files: [
    {
      path: "worker.mjs",
      content: "export default {fetch(){return new Response('ok')}}",
      hash: "recomputed",
    },
  ],
};
const compatibility = { date: "2026-10-19", flags: ["nodejs_compat"] };
const runtime = {
  node: "v24.18.0",
  nodeSha256: "b".repeat(64),
  wrangler: "4.151.1",
  wranglerSha256: "c".repeat(64),
  miniflare: "5.20261012.1-beta",
  miniflareSha256: "d".repeat(64),
  workerd: "1.20261012.1",
  workerdSha256: "a".repeat(64),
  platform: "darwin",
  arch: "arm64",
};
const profile = (activeUs: number) =>
  Buffer.from(
    JSON.stringify({
      startTime: 1,
      endTime: activeUs + 1,
      nodes: [{ id: 1, callFrame: { functionName: "startup" } }],
      samples: [1],
      timeDeltas: [activeUs],
    }),
  );
const evidence = (bytes: Buffer) => ({
  schema: "signalbox/worker-startup-profile/v2",
  status: "passed",
  payloadSha256: startupPayload(bundle, compatibility).sha256,
  budgetMs: 500,
  profileFile: "startup.cpuprofile",
  profileSha256: sha256(bytes),
  invocationSha256: "e".repeat(64),
  runtime,
  invocation: { wranglerExitCode: 0, workerdStarts: 1, workerdClosed: true, guardPassed: true },
});

describe("exact upload startup evidence", () => {
  it("requires actual profile data and recomputes the budget instead of trusting passed", () => {
    const bytes = profile(218_440);
    expect(
      requireStartupEvidence(bundle, compatibility, evidence(bytes), bytes, runtime).summary
        .activeMs,
    ).toBe(218.44);
    const overBudget = profile(300_001);
    expect(() =>
      requireStartupEvidence(bundle, compatibility, evidence(overBudget), overBudget, runtime),
    ).toThrow("BUDGET_EXCEEDED");
    for (const status of ["failed", "skipped", undefined])
      expect(() =>
        requireStartupEvidence(
          bundle,
          compatibility,
          { ...evidence(bytes), status },
          bytes,
          runtime,
        ),
      ).toThrow();
    expect(() =>
      requireStartupEvidence(bundle, compatibility, undefined, bytes, runtime),
    ).toThrow();
  });

  it("rechecks historical profiles against the current budget", () => {
    const bytes = profile(178_898);
    expect(
      requireStartupEvidence(bundle, compatibility, evidence(bytes), bytes, runtime).summary
        .activeMs,
    ).toBe(178.898);
    const stalePass = profile(448_000);
    expect(() =>
      requireStartupEvidence(bundle, compatibility, evidence(stalePass), stalePass, runtime),
    ).toThrow("BUDGET_EXCEEDED");
  });

  it("refuses changed code, module names, module inventory and compatibility settings", () => {
    const bytes = profile(218_440);
    for (const files of [
      [{ ...bundle.files[0], path: "renamed.mjs" }],
      [{ ...bundle.files[0], content: "export default {}" }],
      [...bundle.files, { path: "extra.txt", content: "extra", hash: "recomputed" }],
    ]) {
      const changed: BundleOutput = { hash: bundle.hash, files: [files[0]!, ...files.slice(1)] };
      expect(() =>
        requireStartupEvidence(changed, compatibility, evidence(bytes), bytes, runtime),
      ).toThrow("STALE_PAYLOAD");
    }
    expect(() =>
      requireStartupEvidence(
        bundle,
        { ...compatibility, date: "2026-10-20" },
        evidence(bytes),
        bytes,
        runtime,
      ),
    ).toThrow("STALE_PAYLOAD");
    expect(() =>
      requireStartupEvidence(
        bundle,
        { ...compatibility, flags: [] },
        evidence(bytes),
        bytes,
        runtime,
      ),
    ).toThrow("STALE_PAYLOAD");
    expect(() =>
      requireStartupEvidence(bundle, compatibility, evidence(bytes), profile(1), runtime),
    ).toThrow("PROFILE_CHANGED");
    expect(() =>
      requireStartupEvidence(bundle, compatibility, evidence(bytes), bytes, {
        ...runtime,
        workerd: "other",
      }),
    ).toThrow("STALE_RUNTIME");
  });

  it("serializes the exact modules and compatibility metadata without evaluating code", async () => {
    const { bytes, payload } = await serializeStartupPayload(bundle, compatibility);
    const end = bytes.indexOf("\r\n");
    const boundary = bytes
      .subarray(2, end + 1)
      .toString()
      .trim();
    const form = await new Response(bytes, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }).formData();
    expect(JSON.parse(String(form.get("metadata")))).toEqual({
      main_module: "worker.mjs",
      compatibility_date: compatibility.date,
      compatibility_flags: compatibility.flags,
      bindings: [],
    });
    const module = form.get("worker.mjs");
    expect(module).toBeInstanceOf(Blob);
    if (!(module instanceof Blob)) throw new Error("Missing module blob");
    expect(await module.text()).toBe(bundle.files[0].content);
    expect(payload.modules).toHaveLength(1);
  });
});
