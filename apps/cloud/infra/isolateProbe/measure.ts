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

interface Fixture {
  id: string;
  mainModule: string;
  mode?: "facet" | "worker";
  allowOutbound?: boolean;
  allowGeneratedCode?: boolean;
  entrypoint: string;
  modules: Record<string, { path: string; type: "js" | "cjs" | "text" | "wasm" }>;
  paths: string[];
}

const { values } = NodeUtil.parseArgs({
  options: {
    url: { type: "string" },
    fixture: { type: "string" },
    output: { type: "string" },
    "measure-only": { type: "boolean", default: false },
  },
});
const token = values.url ? process.env.PROBE_SECRET : "local-probe-only";
if (!token) throw new Error("Set PROBE_SECRET for a deployed probe.");
await prepare();
const harness = values.url
  ? undefined
  : createTestHarness({
      workers: [{ configPath: NodePath.join(import.meta.dirname, "wrangler.jsonc") }],
    });
const runId = NodeCrypto.randomBytes(8).toString("hex");
const rows: unknown[] = [];

try {
  const endpoint = values.url ?? (await harness!.listen()).url.toString();
  const send = async (input: object, session: string, modules?: readonly ModuleDescriptor[]) => {
    const url = new URL("/run", endpoint);
    url.searchParams.set("session", session);
    // Node fetch requires duplex for a streaming request body, including over HTTP/1.
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": modules ? MODULE_TRANSPORT_CONTENT_TYPE : "application/json",
      },
      body: modules ? encodeModuleTransport(input, modules) : JSON.stringify(input),
      ...(modules ? { duplex: "half" } : {}),
      signal: AbortSignal.timeout(60_000),
    };
    return requestJson(url, init);
  };
  if (values.fixture) {
    const dir = NodePath.resolve(values.fixture);
    const fixture: Fixture = JSON.parse(
      await NodeFSP.readFile(NodePath.join(dir, "manifest.json"), "utf8"),
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
    environment: values.url ? "deployed" : "local-workerd",
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
