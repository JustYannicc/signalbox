// @effect-diagnostics nodeBuiltinImport:off globalProcess:off - exercise the standalone evidence CLI against a failing HTTP endpoint.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { requestJson } from "./transport.ts";
import { verificationErrors } from "./verify.ts";

describe("probe HTTP evidence", () => {
  it("writes the complete evidence file before failing the CLI on HTML responses", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "isolate-evidence-"));
    const output = NodePath.join(directory, "evidence.json");
    const server = NodeHttp.createServer((request, response) => {
      if (request.url?.startsWith("/root/status")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ memoryUsage: { available: false } }));
      } else {
        response.writeHead(500, { "content-type": "text/html" });
        response.end("<html>upstream failure</html>");
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("No test port");
      const run = NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        [
          NodePath.join(import.meta.dirname, "measure.ts"),
          "--url",
          `http://127.0.0.1:${address.port}`,
          "--output",
          output,
        ],
        { env: { ...process.env, PROBE_SECRET: "test-only" } },
      );
      await expect(run).rejects.toMatchObject({ code: 1 });
      const evidence = JSON.parse(await NodeFSP.readFile(output, "utf8"));
      expect(evidence.rows).toHaveLength(16);
      expect(evidence.rows[0].response.result.memoryUsage.available).toBe(false);
      expect(evidence.rows[1].response).toEqual({
        status: 500,
        error: "<html>upstream failure</html>",
      });
      expect(evidence.verificationErrors.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 15000);

  it("keeps HTTP, parse and network failures serializable beside successful rows", async () => {
    const url = new URL("https://probe.invalid/root/status");
    const attempts = [
      async () => new Response("<html>probe.invalid</html>", { status: 500 }),
      async () => new Response("<html>probe.invalid</html>"),
      async () => {
        throw new Error("connection to probe.invalid failed");
      },
      async () => Response.json({ memoryUsage: { available: false } }),
    ];
    const rows = [];
    for (const fetcher of attempts) {
      rows.push({ path: "/status", ...(await requestJson(url, {}, true, fetcher)) });
    }
    const evidence = JSON.parse(
      JSON.stringify({ rows, verificationErrors: verificationErrors(rows) }),
    );
    expect(evidence.rows).toHaveLength(4);
    expect(evidence.rows[0].response).toEqual({ status: 500, error: "<html>[probe]</html>" });
    expect(evidence.rows[1].response).toEqual({
      status: 200,
      error: "Invalid JSON response: <html>[probe]</html>",
      parseFailure: true,
    });
    expect(evidence.rows[2].response).toEqual({
      error: "Error: connection to [probe] failed",
      transportFailure: true,
    });
    expect(evidence.rows[3].response.result.memoryUsage.available).toBe(false);
    expect(evidence.verificationErrors).toHaveLength(4);
  });
});
