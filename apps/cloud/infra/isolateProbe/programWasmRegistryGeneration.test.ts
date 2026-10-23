import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { prepare } from "./prepare.ts";
import { readChildProgramWasmInventory } from "./programWasmRegistryGeneration.ts";
import { JSPI_WASM } from "./wasmFixture.ts";

const jspiHash = "3c82c5088c45f5acae60187e020c7f3fce285c2bb032323b318d0372b9c6ed50";

function expectDispatchImports(
  imports: readonly { specifier: string; external: boolean | undefined }[],
  specifiers: readonly string[],
) {
  expect(imports.every((entry) => entry.external === true)).toBe(true);
  expect(new Set(imports.map((entry) => entry.specifier))).toEqual(new Set(specifiers));
}

describe("public child WASM registry generation", () => {
  it("emits a closed static module graph and records the references from the same inventory", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "probe-registry-build-"),
    );
    try {
      const wasmDirectory = NodePath.join(directory, "programs");
      await NodeFSP.mkdir(wasmDirectory, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(wasmDirectory, "suspend.wasm"), JSPI_WASM);
      const inventoryPath = NodePath.join(directory, "program-wasm.json");
      await NodeFSP.writeFile(
        inventoryPath,
        JSON.stringify({
          format: "signalbox-child-program-wasm-v1",
          artifacts: [
            {
              name: "suspend.wasm",
              path: "programs/suspend.wasm",
              byteLength: JSPI_WASM.byteLength,
              sha256: jspiHash,
            },
          ],
        }),
      );

      const loaded = await readChildProgramWasmInventory(inventoryPath);
      const generatedDirectory = NodePath.join(directory, "generated");
      const generated = await prepare({
        generatedDirectory,
        programWasmArtifacts: loaded.artifacts,
      });
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(generatedDirectory, "module-inventory.json"), "utf8"),
      );
      const dispatcher = await NodeFSP.readFile(
        NodePath.join(generatedDirectory, "childWorkerDispatch.js"),
        "utf8",
      );

      expect(loaded.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(generated.programWasm.references).toEqual({ "suspend.wasm": jspiHash });
      expect(manifest.programWasm).toEqual({
        references: { "suspend.wasm": jspiHash },
        modules: [
          {
            name: "suspend.wasm",
            moduleName: `wasm/${jspiHash}.wasm`,
            byteLength: JSPI_WASM.byteLength,
            sha256: jspiHash,
            reference: jspiHash,
          },
        ],
      });
      expect(dispatcher).toContain(`./wasm/${jspiHash}.wasm`);
      expect(dispatcher).toContain(jspiHash);
      expectDispatchImports(manifest.dispatchImports, [
        "cloudflare:workers",
        `./wasm/${jspiHash}.wasm`,
      ]);

      const moduleNames = new Set(manifest.modules.map((module: { name: string }) => module.name));
      for (const module of manifest.modules as { name: string; type: string }[]) {
        if (module.type !== "js") continue;
        const source = await NodeFSP.readFile(
          NodePath.join(generatedDirectory, module.name),
          "utf8",
        );
        const imports = source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g);
        for (const [, specifier] of imports) {
          if (!specifier?.startsWith(".")) continue;
          const target = NodePath.posix.normalize(
            NodePath.posix.join(NodePath.posix.dirname(module.name), specifier),
          );
          expect(moduleNames.has(target), `${module.name} imports missing ${target}`).toBe(true);
        }
      }
      expect(
        WebAssembly.validate(
          await NodeFSP.readFile(NodePath.join(generatedDirectory, `wasm/${jspiHash}.wasm`)),
        ),
      ).toBe(true);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the default probe light and rejects a corrupt inventory before writing output", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "probe-registry-empty-"),
    );
    try {
      const defaultDirectory = NodePath.join(directory, "default");
      const defaultBuild = await prepare({ generatedDirectory: defaultDirectory });
      expect(defaultBuild.programWasm.references).toEqual({});
      expect(defaultBuild.programWasm.modules).toEqual([]);
      expectDispatchImports(defaultBuild.dispatchImports, ["cloudflare:workers"]);

      const invalidDirectory = NodePath.join(directory, "invalid");
      await expect(
        prepare({
          generatedDirectory: invalidDirectory,
          programWasmArtifacts: [
            {
              name: "suspend.wasm",
              bytes: JSPI_WASM,
              byteLength: JSPI_WASM.byteLength,
              sha256: "0".repeat(64),
            },
          ],
        }),
      ).rejects.toThrow("Child WASM artifact hash mismatch");
      await expect(NodeFSP.access(invalidDirectory)).rejects.toThrow();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("requires inventory paths and pins to match the file bytes", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-registry-pin-"));
    try {
      const artifactPath = NodePath.join(directory, "suspend.wasm");
      await NodeFSP.writeFile(artifactPath, JSPI_WASM);
      const manifestPath = NodePath.join(directory, "inventory.json");
      const hash = NodeCrypto.createHash("sha256").update(JSPI_WASM).digest("hex");
      await NodeFSP.writeFile(
        manifestPath,
        JSON.stringify({
          format: "signalbox-child-program-wasm-v1",
          artifacts: [
            {
              name: "suspend.wasm",
              path: "suspend.wasm",
              byteLength: JSPI_WASM.byteLength,
              sha256: hash,
            },
          ],
        }),
      );
      const loaded = await readChildProgramWasmInventory(manifestPath);
      expect(loaded.artifacts[0]?.sha256).toBe(hash);
      expect(loaded.artifacts[0]?.bytes).toEqual(JSPI_WASM);
      await NodeFSP.writeFile(
        manifestPath,
        JSON.stringify({
          format: "signalbox-child-program-wasm-v1",
          artifacts: [
            {
              name: "suspend.wasm",
              path: "suspend.wasm",
              byteLength: JSPI_WASM.byteLength,
              sha256: "a".repeat(64),
            },
          ],
        }),
      );
      await expect(readChildProgramWasmInventory(manifestPath)).rejects.toThrow("hash mismatch");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
