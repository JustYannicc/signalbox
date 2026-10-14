import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CLI_PROXY_API_PORT, renderConfig } from "../../apps/cloud/src/pool/cliProxyApi.ts";

const image = `signalbox-cliproxyapi-smoke-${process.pid}`;
const container = `cliproxyapi-smoke-${process.pid}`;
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cliproxyapi-smoke-"));
const dockerfile =
  process.env.CLIPROXYAPI_DOCKERFILE ?? "apps/cloud/containers/cliproxyapi/Dockerfile";
const configPath = NodePath.join(directory, "config.yaml");
const managementKey = "smoke-management-key";
const clientKey = "smoke-client-key";
let started = false;

const docker = (args, options = {}) => {
  const result = NodeChildProcess.spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout?.trim() ?? "";
};

const checkEndpoint = async (origin, path, key) => {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
};

try {
  NodeFS.writeFileSync(configPath, renderConfig({ managementKey, clientKey }));
  NodeFS.chmodSync(directory, 0o777);
  NodeFS.chmodSync(configPath, 0o666);

  docker(["build", "--tag", image, "--file", dockerfile, "."], { stdio: "inherit" });

  docker([
    "run",
    "--detach",
    "--name",
    container,
    "--publish",
    `127.0.0.1::${CLI_PROXY_API_PORT}`,
    "--volume",
    `${directory}:/tmp/cliproxyapi`,
    image,
    "--config",
    "/tmp/cliproxyapi/config.yaml",
  ]);
  started = true;

  const mapping = docker(["port", container, `${CLI_PROXY_API_PORT}/tcp`]).split("\n")[0];
  const hostPort = mapping?.split(":").at(-1);
  if (!hostPort) throw new Error(`Could not read the container port mapping: ${mapping}`);
  const origin = `http://127.0.0.1:${hostPort}`;
  const deadline = Date.now() + 30_000;
  let lastError;
  let ready = false;

  while (Date.now() < deadline) {
    try {
      await checkEndpoint(origin, "/v0/management/config", managementKey);
      await checkEndpoint(origin, "/v1/models", clientKey);
      ready = true;
      console.log("CLIProxyAPI management API and /v1/models responded successfully.");
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!ready)
    throw lastError ?? new Error("CLIProxyAPI did not answer before the startup deadline.");
} catch (error) {
  if (started) {
    const logs = NodeChildProcess.spawnSync("docker", ["logs", container], { encoding: "utf8" });
    if (logs.stdout || logs.stderr) console.error(logs.stdout, logs.stderr);
  }
  throw error;
} finally {
  if (started)
    NodeChildProcess.spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  NodeChildProcess.spawnSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" });
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
