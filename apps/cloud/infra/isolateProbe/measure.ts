// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - the probe measures native HTTP and wall clocks without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { createTestHarness } from "wrangler";
import { prepare } from "./prepare.ts";
import { verificationErrors } from "./verify.ts";
import { requestJson } from "./transport.ts";
import {
  encodeModuleTransport,
  MODULE_TRANSPORT_CONTENT_TYPE,
  type ModuleDescriptor,
} from "./moduleTransport.ts";

interface FixtureRequest {
  path: string;
  method?: string;
  bodyFile?: string;
  contentType?: string;
}

interface Fixture {
  id: string;
  mainModule: string;
  mode?: "facet" | "worker";
  allowOutbound?: boolean;
  allowGeneratedCode?: boolean;
  entrypoint: string;
  modules: Record<string, { path: string; type: "js" | "cjs" | "text" | "wasm" }>;
  paths?: string[];
  requests?: FixtureRequest[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseFixture(value: unknown): Fixture {
  if (!isRecord(value)) throw new Error("Fixture manifest must be an object");
  const hasPaths = Object.hasOwn(value, "paths");
  const hasRequests = Object.hasOwn(value, "requests");
  if (hasPaths === hasRequests) {
    throw new Error("Fixture manifest must define exactly one of paths or requests");
  }
  if (typeof value.id !== "string" || !value.id) throw new Error("Fixture id is required");
  if (typeof value.mainModule !== "string") throw new Error("Fixture mainModule is required");
  if (typeof value.entrypoint !== "string") throw new Error("Fixture entrypoint is required");
  if (!isRecord(value.modules)) throw new Error("Fixture modules must be an object");
  if (value.mode !== undefined && value.mode !== "facet" && value.mode !== "worker") {
    throw new Error("Fixture mode must be facet or worker");
  }
  if (hasPaths) {
    if (!Array.isArray(value.paths) || !value.paths.every((path) => typeof path === "string")) {
      throw new Error("Fixture paths must be an array of strings");
    }
    return value as unknown as Fixture;
  }
  if (!Array.isArray(value.requests)) throw new Error("Fixture requests must be an array");
  const requests = value.requests.map((request, index): FixtureRequest => {
    if (!isRecord(request)) throw new Error(`Fixture request ${index} must be an object`);
    if (
      Object.keys(request).some(
        (key) => !["path", "method", "bodyFile", "contentType"].includes(key),
      )
    ) {
      throw new Error(`Fixture request ${index} has an unsupported field`);
    }
    if (typeof request.path !== "string" || !request.path) {
      throw new Error(`Fixture request ${index} requires a path`);
    }
    if (
      request.method !== undefined &&
      (typeof request.method !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(request.method) ||
        ["CONNECT", "TRACE", "TRACK"].includes(request.method.toUpperCase()))
    ) {
      throw new Error(`Fixture request ${index} has an invalid method`);
    }
    if (
      request.contentType !== undefined &&
      (typeof request.contentType !== "string" || /[\r\n\0]/.test(request.contentType))
    ) {
      throw new Error(`Fixture request ${index} has an invalid contentType`);
    }
    if (request.bodyFile !== undefined) {
      if (
        typeof request.bodyFile !== "string" ||
        !request.bodyFile ||
        NodePath.isAbsolute(request.bodyFile) ||
        NodePath.win32.isAbsolute(request.bodyFile)
      ) {
        throw new Error(`Fixture request ${index} bodyFile must be a relative path`);
      }
      const method = typeof request.method === "string" ? request.method : "GET";
      if (["GET", "HEAD"].includes(method.toUpperCase())) {
        throw new Error(
          `Fixture request ${index} bodyFile requires a method other than GET or HEAD`,
        );
      }
    }
    return request as unknown as FixtureRequest;
  });
  return { ...value, requests } as unknown as Fixture;
}

function isWithinDirectory(directory: string, file: string) {
  const relative = NodePath.relative(directory, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

async function readFixtureBody(directory: string, bodyFile: string) {
  const root = await NodeFSP.realpath(directory);
  const file = await NodeFSP.realpath(NodePath.resolve(root, bodyFile));
  if (!isWithinDirectory(root, file)) {
    throw new Error(`Fixture bodyFile must stay inside the fixture directory: ${bodyFile}`);
  }
  return NodeFSP.readFile(file);
}

const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    fixture: { type: "string" },
    output: { type: "string" },
    "measure-only": { type: "boolean", default: false },
  },
});
const deployedUrl = values.url ?? process.env.PROBE_URL;
const token = deployedUrl ? process.env.PROBE_SECRET : "local-probe-only";
if (!token) throw new Error("Set PROBE_SECRET for a deployed probe.");
await prepare();
const harness = deployedUrl
  ? undefined
  : createTestHarness({
      workers: [{ configPath: NodePath.join(import.meta.dirname, "wrangler.jsonc") }],
    });
const runId = NodeCrypto.randomBytes(8).toString("hex");
const rows: unknown[] = [];

try {
  const endpoint = deployedUrl ?? (await harness!.listen()).url.toString();
  const send = async (
    input: object,
    session: string,
    modules?: readonly ModuleDescriptor[],
    payload?: Uint8Array,
  ) => {
    const url = new URL("/run", endpoint);
    url.searchParams.set("session", session);
    // Node fetch requires duplex for a streaming request body, including over HTTP/1.
    const hasModuleTransport = modules !== undefined || payload !== undefined;
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": hasModuleTransport ? MODULE_TRANSPORT_CONTENT_TYPE : "application/json",
      },
      body: hasModuleTransport
        ? encodeModuleTransport(input, modules ?? [], {}, payload)
        : JSON.stringify(input),
      ...(hasModuleTransport ? { duplex: "half" } : {}),
      signal: AbortSignal.timeout(60_000),
    };
    return requestJson(url, init);
  };
  if (values.fixture) {
    const dir = NodePath.resolve(values.fixture);
    const fixture = parseFixture(
      JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "manifest.json"), "utf8")),
    );
    const modules: ModuleDescriptor[] = [];
    const inventory: object[] = [];
    for (const [name, module] of Object.entries(fixture.modules)) {
      const bytes = await NodeFSP.readFile(NodePath.resolve(dir, module.path));
      modules.push({ name, type: module.type, bytes });
      inventory.push({
        name,
        type: module.type,
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
    if (fixture.paths) {
      for (const [index, path] of fixture.paths.entries()) {
        const id = `${runId}-${fixture.id}`;
        rows.push({
          fixture: fixture.id,
          cold: index === 0,
          path,
          inventory,
          ...(await send(
            {
              id,
              mode: fixture.mode ?? "facet",
              allowOutbound: fixture.allowOutbound === true,
              allowGeneratedCode: fixture.allowGeneratedCode === true,
              path,
              mainModule: fixture.mainModule,
              entrypoint: fixture.entrypoint,
            },
            id,
            modules,
          )),
        });
      }
    } else {
      for (const [index, request] of fixture.requests!.entries()) {
        const id = `${runId}-${fixture.id}`;
        const payload = request.bodyFile ? await readFixtureBody(dir, request.bodyFile) : undefined;
        const requestEvidence = {
          path: request.path,
          method: request.method ?? "GET",
          ...(request.contentType !== undefined ? { contentType: request.contentType } : {}),
          ...(payload
            ? {
                payload: {
                  bytes: payload.byteLength,
                  sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
                  bodyFile: request.bodyFile,
                },
              }
            : {}),
        };
        rows.push({
          fixture: fixture.id,
          cold: index === 0,
          path: request.path,
          request: requestEvidence,
          inventory,
          ...(await send(
            {
              id,
              mode: fixture.mode ?? "facet",
              allowOutbound: fixture.allowOutbound === true,
              allowGeneratedCode: fixture.allowGeneratedCode === true,
              path: request.path,
              ...(request.method !== undefined ? { method: request.method } : {}),
              ...(request.contentType !== undefined ? { contentType: request.contentType } : {}),
              mainModule: fixture.mainModule,
              entrypoint: fixture.entrypoint,
            },
            id,
            modules,
            payload,
          )),
        });
      }
    }
  } else {
    for (const path of ["/status", "/capabilities", "/jspi", "/wasm", "/sqlite?mib=16"]) {
      const url = new URL(`/root${path}`, endpoint);
      url.searchParams.set("session", `${runId}-root-${rows.length}`);
      rows.push({
        target: "do",
        path,
        ...(await requestJson(
          url,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(60_000),
          },
          true,
        )),
      });
    }
    for (const path of ["/status", "/capabilities", "/jspi", "/wasm", "/sqlite?mib=16"]) {
      const id = `${runId}-${rows.length}`;
      rows.push({ path, ...(await send({ id, path }, id)) });
    }
    for (let sample = 0; sample < 3; sample++) {
      const id = `${runId}-generated-${sample}`;
      const generatedValue = NodeCrypto.randomInt(1, 1000000);
      rows.push({
        scenario: "request-time-codegen",
        generatedValue,
        ...(await send({ id, mode: "worker", generatedValue }, id)),
      });
    }
    for (const count of [1, 10, 11]) {
      const id = `${runId}-concurrent-${count}`;
      rows.push({ scenario: "worker-handles", count, ...(await send({ id, count }, id)) });
    }
  }
  const evidence = {
    schemaVersion: 1,
    environment: deployedUrl ? "deployed" : "local-workerd",
    measuredAt: new Date().toISOString(),
    runId,
    rows,
    verificationErrors: verificationErrors(rows),
  };
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (values.output) await NodeFSP.writeFile(values.output, output);
  process.stdout.write(output);
  if (!values["measure-only"] && evidence.verificationErrors.length > 0) process.exitCode = 1;
} finally {
  await harness?.close();
}
