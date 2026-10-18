// @effect-diagnostics nodeBuiltinImport:off - inspect actual prepared package source, without launching Claude.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { parse } from "acorn";
import { prepareProofEnvironment } from "./prepareEnvironment.ts";

const sha256 = (source: string) => NodeCrypto.createHash("sha256").update(source).digest("hex");

describe("proof package preparation", () => {
  it("keeps raw provenance and startup WASM while removing ambient native imports", async () => {
    const environment = await prepareProofEnvironment();
    expect(environment.workerModules).toHaveLength(2);
    expect(environment.startupWasm).toHaveLength(2);
    for (const [index, module] of environment.workerModules.entries()) {
      const tree = parse(module.source, { sourceType: "module", ecmaVersion: "latest" });
      const imports = tree.body
        .filter((statement) => statement.type === "ImportDeclaration")
        .map((statement) => statement.source.value);
      expect(imports.every((path) => typeof path === "string" && path.endsWith(".wasm"))).toBe(
        true,
      );
      expect(module.source).toContain("signalbox.nodeBridge.v1");
      const raw = environment.raw.workerModules[index]!;
      expect(environment.provenance.raw[index]?.sha256).toBe(sha256(raw.source));
      expect(environment.provenance.rebound[index]?.sha256).toBe(sha256(module.source));
      expect(environment.provenance.raw[index]?.sha256).not.toBe(
        environment.provenance.rebound[index]?.sha256,
      );
    }
    for (const module of environment.startupWasm)
      expect([...module.bytes.subarray(0, 4)]).toEqual([0, 97, 115, 109]);
    expect(environment.provenance.routesSha256).toBe(
      sha256(JSON.stringify(environment.provenance.routes)),
    );
  });
});
