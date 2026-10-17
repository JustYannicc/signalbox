import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CLI_PROXY_API_PORT,
  managedConfig,
  renderConfig,
} from "../../apps/cloud/src/pool/cliProxyApi.ts";

const image = `signalbox-cliproxyapi-smoke-${process.pid}`;
const container = `cliproxyapi-smoke-${process.pid}`;
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cliproxyapi-smoke-"));
const dockerfile =
  process.env.CLIPROXYAPI_DOCKERFILE ?? "apps/cloud/containers/cliproxyapi/Dockerfile";
const dockerfilePath = NodePath.resolve(dockerfile);
const buildContext = NodePath.dirname(dockerfilePath);
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

const checkEndpoint = async (origin, path, key, init = {}) => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...init.headers },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return body;
};

/** Patches a pool's managed config in, as a routing change does, and reads it back. */
const applyRouting = async (origin, routing) => {
  // v8 rejects legacy field names, so this also checks the tree is current.
  await checkEndpoint(origin, "/v8/management/config", managementKey, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(managedConfig(routing)),
  });
  const config = JSON.parse(await checkEndpoint(origin, "/v8/management/config", managementKey));
  const applied = {
    strategy: config.routing?.strategy,
    sessionAffinity: config.routing?.["session-affinity"],
    moveOn: config.routing?.["session-affinity-rebind-on"],
    usageStatistics: config.observability?.usage?.["usage-statistics-enabled"],
  };
  const expected = { ...routing, usageStatistics: true };
  if (JSON.stringify(applied) !== JSON.stringify(expected)) {
    throw new Error(`The managed config did not apply: ${JSON.stringify(applied)}`);
  }
};

/** The v8 management calls a cloud pool makes, against the pinned release. */
const checkPoolCalls = async (origin) => {
  await checkEndpoint(origin, "/v8/management/credentials", managementKey);
  await applyRouting(origin, { strategy: "fill-first", sessionAffinity: false, moveOn: "quota" });
  await applyRouting(origin, { strategy: "round-robin", sessionAffinity: true, moveOn: "any" });
};

try {
  NodeFS.writeFileSync(configPath, renderConfig({ managementKey, clientKey }));
  NodeFS.chmodSync(directory, 0o777);
  NodeFS.chmodSync(configPath, 0o666);

  docker(
    [
      "build",
      "--build-arg",
      "CLIPROXYAPI_TEST_CARRIED_FLOWS=1",
      "--tag",
      image,
      "--file",
      dockerfilePath,
      buildContext,
    ],
    { stdio: "inherit" },
  );

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
      await checkEndpoint(origin, "/v8/management/config", managementKey);
      await checkEndpoint(origin, "/v1/models", clientKey);
      ready = true;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!ready)
    throw lastError ?? new Error("CLIProxyAPI did not answer before the startup deadline.");
  await checkPoolCalls(origin);
  console.log(
    "CLIProxyAPI's fake-auth Codex device-login and Claude manual-login tests, v8 management API, managed config and /v1/models work.",
  );
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
