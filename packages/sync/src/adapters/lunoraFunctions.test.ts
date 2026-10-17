/// <reference types="node" />
// @effect-diagnostics nodeBuiltinImport:off -- This proof runs the real Lunora CLI and tsc in a temporary project.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { emitLunoraFunctions } from "@signalbox/sync/adapters/lunoraFunctions";
import { defineHome } from "@signalbox/sync/definition";

const counterDefinition = defineHome(
  {
    actor: Schema.Struct({ userId: Schema.String }),
    home: Schema.Struct({ id: Schema.String }),
    tables: {},
  },
  ({ view, change, projection }) => ({
    views: {
      absent: view({
        input: Schema.Void,
        output: Schema.Void,
        failure: Schema.Never,
        run: () => Effect.void,
      }),
      date: view({
        input: Schema.DateFromString,
        output: Schema.DateFromString,
        failure: Schema.Never,
        run: (_context, value) => Effect.succeed(value),
      }),
      nullable: view({
        input: Schema.Void,
        output: Schema.Null,
        failure: Schema.Literal("missing"),
        run: () => Effect.succeed(null),
      }),
    },
    changes: {
      date: change({
        input: Schema.DateFromString,
        output: Schema.DateFromString,
        failure: Schema.Never,
        run: (_context, value) => Effect.succeed(value),
      }),
      absent: change({
        input: Schema.Void,
        output: Schema.Void,
        failure: Schema.Void,
        run: () => Effect.void,
      }),
    },
    projections: {
      touch: projection({
        input: Schema.Void,
        output: Schema.Null,
        failure: Schema.Never,
        run: () => Effect.succeed(null),
      }),
    },
  }),
);

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const require = NodeModule.createRequire(import.meta.url);
const syncPackage = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
const templates = NodePath.join(syncPackage, "codegen-proof", "tests", "fixtures");

function generatedSource() {
  return emitLunoraFunctions(counterDefinition, {
    definitionImport: "./home.js",
    definitionExport: "counterDefinition",
    bindingImport: "./bindings.js",
  });
}

async function makeNodeModules(project: string): Promise<void> {
  const source = NodePath.join(syncPackage, "node_modules");
  const target = NodePath.join(project, "node_modules");
  await NodeFSP.mkdir(target, { recursive: true });
  for (const entry of await NodeFSP.readdir(source)) {
    if (entry === "@signalbox") continue;
    await NodeFSP.symlink(NodePath.join(source, entry), NodePath.join(target, entry), "dir");
  }
  const signalboxScope = NodePath.join(target, "@signalbox");
  await NodeFSP.mkdir(signalboxScope, { recursive: true });
  await NodeFSP.symlink(syncPackage, NodePath.join(signalboxScope, "sync"), "dir");
  if (NodeProcess.env.LUNORA_UMBRELLA_PACKAGE !== undefined) {
    const umbrella = NodePath.join(target, "lunorash");
    await NodeFSP.rm(umbrella, { recursive: true, force: true });
    await NodeFSP.symlink(NodeProcess.env.LUNORA_UMBRELLA_PACKAGE, umbrella, "dir");
  }
}

async function writeFixture(project: string, relativePath: string, source: string): Promise<void> {
  const destination = NodePath.join(project, relativePath);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.writeFile(destination, source);
}

async function copyTemplate(project: string, fileName: string, destination: string): Promise<void> {
  await writeFixture(
    project,
    destination,
    await NodeFSP.readFile(NodePath.join(templates, fileName), "utf8"),
  );
}

describe("emitLunoraFunctions", () => {
  it("returns a deterministic operation map and emits literal public/internal functions", () => {
    const emitted = generatedSource();

    expect(emitted.functions).toEqual({
      views: { absent: "view_absent", date: "view_date", nullable: "view_nullable" },
      changes: { absent: "change_absent", date: "change_date" },
      projections: { touch: "project_touch" },
    });
    expect(emitted.source).toContain("export const view_absent = query");
    expect(emitted.source).toContain("value: v.object({ defined: v.literal(false) })");
    expect(emitted.source).toContain("export const project_touch = internalMutation");
    expect(emitted.source).not.toContain("v.from(");
    expect(emitted.source).not.toContain("actor: v.");
  });

  it.each(["eager", "lazy"])(
    "runs %s codegen and strict client type checks against emitted validators",
    async (mode) => {
      const project = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "sync-lunora-functions-"),
      );
      try {
        await makeNodeModules(project);
        await writeFixture(
          project,
          "package.json",
          JSON.stringify({
            name: "@signalbox/sync-generated-functions-proof",
            private: true,
            type: "module",
            dependencies: { lunorash: "1.0.0-alpha.398" },
          }),
        );
        await writeFixture(
          project,
          "lunora/schema.ts",
          `import { defineSchema, defineTable, v } from "lunorash/server";
export default defineSchema({ probes: defineTable({ key: v.string() }).index("by_key", ["key"]) });
`,
        );
        await copyTemplate(project, "functions-home.ts", "lunora/home.ts");
        await copyTemplate(project, "functions-bindings.ts", "lunora/bindings.ts");
        await copyTemplate(project, "functions-identity.ts", "lunora/identity.ts");

        const cli =
          NodeProcess.env.LUNORA_CODEGEN_CLI ??
          NodePath.join(NodePath.dirname(require.resolve("lunorash/package.json")), "dist/bin.mjs");
        const tsc = NodePath.join(
          NodePath.dirname(require.resolve("typescript/package.json")),
          "bin/tsc",
        );
        const runCodegen = () =>
          execute(
            NodeProcess.execPath,
            [cli, "codegen", ...(mode === "lazy" ? ["--lazy-functions"] : [])],
            { cwd: project },
          );
        await runCodegen();
        await writeFixture(project, "lunora/functions.ts", generatedSource().source);
        await runCodegen();
        await copyTemplate(project, "functions-contract.ts", "src/functions-contract.ts");
        await writeFixture(
          project,
          "tsconfig.json",
          JSON.stringify({
            compilerOptions: {
              target: "ES2023",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              exactOptionalPropertyTypes: true,
              skipLibCheck: true,
              noEmit: true,
              allowImportingTsExtensions: true,
              lib: ["ES2023", "DOM"],
              types: ["node", "@cloudflare/workers-types"],
            },
            include: ["lunora", "src"],
          }),
        );
        try {
          await execute(NodeProcess.execPath, [tsc, "--noEmit", "--project", "tsconfig.json"], {
            cwd: project,
            maxBuffer: 5_000_000,
          });
        } catch (error) {
          if (error instanceof Error && "stdout" in error && "stderr" in error) {
            const details = [String(error.stdout), String(error.stderr)].filter(Boolean).join("\n");
            throw new Error(details, { cause: error });
          }
          throw error;
        }
      } finally {
        await NodeFSP.rm(project, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it("rejects unsupported names and encoded schema nodes", () => {
    const badName = {
      ...counterDefinition,
      views: { "not-valid": counterDefinition.views.absent },
    } as unknown as typeof counterDefinition;
    expect(() =>
      emitLunoraFunctions(badName, {
        definitionImport: "./home.js",
        bindingImport: "./bindings.js",
      }),
    ).toThrow(/must be a valid JavaScript identifier/u);

    const unsupported = defineHome(
      { actor: Schema.String, home: Schema.String, tables: {} },
      ({ view }) => ({
        views: {
          bigint: view({
            input: Schema.BigInt,
            output: Schema.BigInt,
            failure: Schema.Never,
            run: (_context, value) => Effect.succeed(value),
          }),
        },
        changes: {},
        projections: {},
      }),
    );
    expect(() =>
      emitLunoraFunctions(unsupported, {
        definitionImport: "./home.js",
        bindingImport: "./bindings.js",
      }),
    ).toThrow(/BigInt is not a supported JSON value/u);
  });
});
