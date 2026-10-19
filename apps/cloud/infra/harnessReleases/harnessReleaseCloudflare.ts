import { Cloudflare, ownedScript, type OwnedWorker } from "../isolateProbe/ciCloudflare.ts";
import { record, textField } from "../isolateProbe/ciArchive.ts";

type DeploymentRequest =
  | {
      readonly action: "deploy";
      readonly script: string;
      readonly root: string;
      readonly modules: ReadonlyArray<ProbeModule>;
      readonly secret: string;
    }
  | {
      readonly action: "request";
      readonly script: string;
      readonly resource: "settings" | "deployments";
    }
  | { readonly action: "cleanup"; readonly script: string };

type ProbeModule = { readonly name: string; readonly type: "js" | "wasm" };

async function stdinText(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const input = Buffer.from(chunk);
    bytes += input.byteLength;
    if (bytes > 1_000_000) throw new Error("HARNESS_RELEASE_CLOUDFLARE_INPUT_TOO_LARGE");
    chunks.push(input);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(value: unknown): DeploymentRequest {
  const input = record(value);
  const action = textField(input, "action");
  const script = textField(input, "script");
  if (!ownedScript(script)) throw new Error("Invalid owned script");
  if (action === "cleanup") return { action, script };
  if (action === "request") {
    const resource = textField(input, "resource");
    if (resource !== "settings" && resource !== "deployments")
      throw new Error("Invalid Cloudflare resource");
    return { action, script, resource };
  }
  if (action !== "deploy") throw new Error("Invalid Cloudflare action");
  const root = textField(input, "root");
  const secret = textField(input, "secret");
  if (!Array.isArray(input.modules) || input.modules.length === 0)
    throw new Error("Invalid probe module inventory");
  const modules = input.modules.map((value): ProbeModule => {
    const module = record(value);
    const name = textField(module, "name");
    if (/[\\/]/u.test(name) || name === "." || name === "..")
      throw new Error("Invalid probe module name");
    if (module.type === "js") return { name, type: "js" };
    if (module.type === "wasm") return { name, type: "wasm" };
    throw new Error("Invalid probe module type");
  });
  if (new Set(modules.map((module) => module.name)).size !== modules.length)
    throw new Error("Duplicate probe module name");
  return { action, script, root, modules, secret };
}

async function main(): Promise<unknown> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("CI Cloudflare configuration is missing");
  const request = parseRequest(JSON.parse(await stdinText()));
  const cloud = new Cloudflare(account, token);
  if (request.action === "request")
    return cloud.request(`/workers/scripts/${request.script}/${request.resource}`);
  if (request.action === "cleanup") {
    await cloud.cleanup({ script: request.script });
    return { deleted: true };
  }
  const worker: OwnedWorker = { script: request.script };
  const url = await cloud.deploy(worker, request.root, [...request.modules], request.secret);
  if (!worker.namespace || !worker.version) throw new Error("Deployment identity is incomplete");
  const settings = await cloud.request(`/workers/scripts/${request.script}/settings`);
  return { url, namespace: worker.namespace, version: worker.version, settings };
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
