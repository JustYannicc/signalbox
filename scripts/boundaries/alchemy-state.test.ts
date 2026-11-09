// @effect-diagnostics nodeBuiltinImport:off - isolate stack evaluation and run the existing Node boundary suite without loading Alchemy.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import { expect, test } from "@effect/vitest";
import ts from "typescript-legacy";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const refusal =
  "this stack needs a Signalbox-owned state store; the shared alchemy-state-store is forbidden";
const stateStoreUrl = new URL("../../infra/signalboxStateStore.ts", import.meta.url);

test.each(["apps/cloud/alchemy.run.ts", "infra/relay/alchemy.run.ts"])(
  "%s refuses before bootstrap or network access",
  async (entrypoint) => {
    const url = new URL(`../../${entrypoint}`, import.meta.url);
    const source = NodeModule.stripTypeScriptTypes(await NodeFSP.readFile(url, "utf8"));
    const imports = ts.createSourceFile(entrypoint, source, ts.ScriptTarget.Latest, true);
    const calls: string[] = [];
    const forbidden = (name: string) => () => {
      calls.push(name);
      throw new Error(`Unexpected ${name}`);
    };
    // No real dependency is loaded. Only the entrypoint and refusal helper execute.
    const context = NodeVM.createContext({ fetch: forbidden("network") });
    const stateStore = new NodeVM.SourceTextModule(
      NodeModule.stripTypeScriptTypes(await NodeFSP.readFile(stateStoreUrl, "utf8")),
      { context, identifier: stateStoreUrl.href },
    );
    await stateStore.link(() => {
      throw new Error("The refusal helper must not load dependencies");
    });
    await stateStore.evaluate();
    const entry = new NodeVM.SourceTextModule(source, {
      context,
      identifier: url.href,
      importModuleDynamically: async (specifier) => {
        expect(new URL(specifier, url).href).toBe(stateStoreUrl.href);
        return stateStore;
      },
    });
    await entry.link((specifier) => {
      const values: Record<string, unknown> = {
        Stack: forbidden("Alchemy bootstrap"),
        state: forbidden("Cloudflare shared state"),
        providers: () => undefined,
        mergeAll: () => undefined,
      };
      for (const statement of imports.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== specifier
        )
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            const name = (binding.propertyName ?? binding.name).text;
            values[name] = name.endsWith("_FLAGS") ? [] : undefined;
          }
        }
      }
      return new NodeVM.SyntheticModule(
        Object.keys(values),
        function () {
          for (const [name, value] of Object.entries(values)) this.setExport(name, value);
        },
        { context },
      );
    });
    await expect(entry.evaluate()).rejects.toThrow(refusal);
    expect(calls).toEqual([]);
  },
);

test("the shared-state boundary rejects every stack and scans the repository", async () => {
  await execFile(
    "node",
    ["--test", NodeURL.fileURLToPath(new URL("./alchemy-state-tests.mjs", import.meta.url))],
    { cwd: NodeURL.fileURLToPath(new URL("../../", import.meta.url)) },
  );
});
