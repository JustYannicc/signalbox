// @effect-diagnostics nodeBuiltinImport:off - exercise deployed measurement against an owned HTTP endpoint, without workerd.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";

it("checks its own upload before every CLI fixture case on one connection", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-case-stage-"));
  const paths: string[] = [];
  const sockets = new Set<NodeHttp.IncomingMessage["socket"]>();
  const healthStarted = Promise.withResolvers<NodeHttp.ServerResponse>();
  const server = NodeHttp.createServer(async (request, response) => {
    paths.push(request.url!);
    sockets.add(request.socket);
    // Fully consume streamed uploads before replying, as the real outer router does.
    for await (const _chunk of request) {
    }
    if (request.headers.authorization !== "Bearer stage-test") {
      response.writeHead(401).end();
    } else if (request.url === "/probe/health") {
      if (paths.length === 5) {
        healthStarted.resolve(response);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ready: true, versionId: "cli-upload", workerName: "127" }));
      }
    } else if (request.url === "/") {
      response.writeHead(400, { "content-type": "text/plain" }).end("Invalid session");
    } else if (request.url === "/root/status?session=readiness") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ retainedBytes: 0, memoryUsage: {}, heapStatistics: {} }));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: 200, result: { ok: true } }));
    }
  });
  let child: ReturnType<typeof NodeChildProcess.execFile> | undefined;
  let measurement: Promise<unknown> | undefined;
  let heldHealth: NodeHttp.ServerResponse | undefined;
  try {
    await NodeFSP.writeFile(NodePath.join(directory, "module.js"), "export default {};\n");
    await NodeFSP.writeFile(
      NodePath.join(directory, "manifest.json"),
      JSON.stringify({
        id: "stage",
        mainModule: "main.js",
        entrypoint: "ProbeFacet",
        modules: { "main.js": { path: "module.js", type: "js" } },
        paths: ["/first", "/second"],
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing stage port");
    const pending = NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "measure.ts"),
        "--fixture",
        directory,
        "--output",
        NodePath.join(directory, "evidence.json"),
      ],
      {
        env: {
          ...process.env,
          PROBE_URL: `http://127.0.0.1:${address.port}`,
          PROBE_SECRET: "stage-test",
          PROBE_VERSION_ID: "cli-upload",
        },
      },
    );
    child = pending.child;
    measurement = pending;
    heldHealth = await Promise.race([
      healthStarted.promise,
      pending.then(() => {
        throw new Error("CLI completed before the second health gate");
      }),
    ]);
    expect(paths.filter((path) => path.startsWith("/run?session="))).toHaveLength(1);
    heldHealth.writeHead(200, { "content-type": "application/json" });
    heldHealth.end(JSON.stringify({ ready: true, versionId: "cli-upload", workerName: "127" }));
    await pending;
    const evidence = JSON.parse(
      await NodeFSP.readFile(NodePath.join(directory, "evidence.json"), "utf8"),
    );
    expect(evidence.verificationErrors).toEqual([]);
    expect(evidence.rows.map((row: { path: string }) => row.path)).toEqual(["/first", "/second"]);
    expect(paths.map((path) => (path.startsWith("/run?") ? "/run" : path))).toEqual([
      "/probe/health",
      "/",
      "/root/status?session=readiness",
      "/run",
      "/probe/health",
      "/",
      "/root/status?session=readiness",
      "/run",
    ]);
    expect(sockets.size).toBe(1);
  } finally {
    heldHealth?.end();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await measurement?.catch(() => {});
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
