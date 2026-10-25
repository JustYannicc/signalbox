// @effect-diagnostics nodeBuiltinImport:off - verify diagnostics emitted by real subprocess failures.
import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { diagnostics, runProcess } from "./process.ts";
import { runProbe } from "./run.ts";

describe("probe failure diagnostics", () => {
  it("reports the operating error while hiding credential echoes and endpoints", async () => {
    let secret: string | undefined;
    const probe = runProbe(
      {},
      {
        log: () => {},
        run: async (input) => {
          secret = input.env.PROBE_SECRET;
          if (input.args[0] === "destroy") return { code: 0, stdout: "", stderr: "" };
          return runProcess({
            ...input,
            command: process.execPath,
            args: [
              "-e",
              String.raw`
          console.error('Cloudflare API 10000: authentication failed; Workers Scripts write permission required');
          console.error('PROBE_SECRET=' + process.env.PROBE_SECRET);
          console.error('Bearer fake-unknown-token');
          console.log("url: 'https://sb-isolate-probe-12345678.account.workers.dev'");
          console.error('sb-isolate-probe-12345678.account.workers.dev');
          process.exit(1);
        `,
            ],
          });
        },
      },
    );
    const error = await probe.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Missing failure");
    expect(error.message).toContain(
      "authentication failed; Workers Scripts write permission required",
    );
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("workers.dev");
    expect(error.message).not.toContain("https://");
    expect(error.message).not.toContain("fake-unknown-token");
  });

  it("redacts known credentials before bounding each diagnostic stream", () => {
    const env = {
      PROBE_SECRET: "private-probe",
      CLOUDFLARE_API_TOKEN: "private-cloudflare",
      ALCHEMY_PASSWORD: "private/password",
    };
    const result = diagnostics(
      "x".repeat(5000) + "private-probe",
      "y".repeat(5000) + " private-cloudflare private%2Fpassword HTTP 429: rate limit",
      env,
    );
    expect(result.length).toBeLessThanOrEqual(8193);
    expect(result).toContain("HTTP 429: rate limit");
    expect(result).not.toContain("private");
  });

  it("retains redacted stderr when an active child is cancelled", async () => {
    await expect(
      runProcess({
        command: process.execPath,
        args: [
          "-e",
          "console.error('Cloudflare 429 token=' + process.env.PROBE_SECRET); setInterval(() => {}, 1000)",
        ],
        cwd: NodeOS.tmpdir(),
        env: { PROBE_SECRET: "fake-private" },
        timeoutMs: 10_000,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow(/Cloudflare 429 token=\[credential\]/);
  });
});
