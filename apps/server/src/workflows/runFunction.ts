import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeModule from "node:module";
import * as NodeProcess from "node:process";
import { parseSync } from "oxc-parser";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { ProcessRunner } from "../processRunner.ts";
import { automationError, errorMessage, fail, isAutomationError } from "./errors.ts";
import { fromJson, toJson } from "./json.ts";
import { findPackageRunner } from "./packageRunner.ts";

/**
 * `w.run(label, fn, ...args)`: calls a top-level function of the automation
 * file in a real Node process, with the npm packages the file imports
 * installed next to it. Each automation version gets its own directory under
 * the server's state dir; packages install once per version.
 */

const RUN_TIMEOUT = "15 minutes";
const INSTALL_TIMEOUT = "10 minutes";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Reads `{ name, args }` from stdin, calls the export, and writes `{ ok, value | error }` to the result file. */
const RUNNER = `import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { modulePath, name, args, resultPath } = JSON.parse(readFileSync(0, "utf8"));
let result;
try {
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module[name] !== "function") throw new Error(name + " isn't a function in this automation.");
  const value = await module[name](...args);
  result = { ok: true, value: value === undefined ? null : value };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
}
writeFileSync(resultPath, JSON.stringify(result));
process.exit(0);
`;

/** Package names the module imports: `lodash`, `@scope/pkg` from `@scope/pkg/sub`. Node built-ins and relative paths are skipped. */
export function importedPackages(module: string): string[] {
  const { module: record } = parseSync("automation.mjs", module, { sourceType: "module" });
  const specifiers = [
    ...record.staticImports.map((entry) => entry.moduleRequest.value),
    ...record.staticExports.flatMap((entry) =>
      entry.entries.flatMap((item) => (item.moduleRequest ? [item.moduleRequest.value] : [])),
    ),
    // Dynamic imports only count with a literal specifier.
    ...record.dynamicImports.flatMap((entry) => {
      const text = module.slice(entry.moduleRequest.start, entry.moduleRequest.end);
      return /^(["'])[^"']+\1$/.test(text) ? [text.slice(1, -1)] : [];
    }),
  ];
  const names = new Set<string>();
  for (const specifier of specifiers) {
    if (!specifier || /^(\.|\/|node:)/.test(specifier) || NodeModule.isBuiltin(specifier)) continue;
    const parts = specifier.split("/");
    names.add(specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
  }
  return [...names].toSorted();
}

export const makeRunFunction = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const processes = yield* ProcessRunner;
  const installs = yield* KeyedLock.make<string>();
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  /**
   * pnpm when it's on PATH (with --ignore-workspace, so a parent workspace is
   * never touched), else the npm next to Node, else npm on PATH.
   */
  const npmInstall = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
  const packageInstaller = findPackageRunner([
    { name: "pnpm", args: ["add", "--ignore-workspace", "--ignore-scripts", "--reporter=silent"] },
    { name: "npm", besideNode: true, args: npmInstall },
  ]).pipe(Effect.map(Option.getOrElse(() => ({ command: "npm", args: npmInstall }))));

  const ensureInstalled = (directory: string, module: string, env: NodeJS.ProcessEnv) =>
    installs.withLock(
      directory,
      Effect.gen(function* () {
        const marker = path.join(directory, ".installed");
        if (yield* fs.exists(marker)) return;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "automation.mjs"), module);
        yield* fs.writeFileString(path.join(directory, "runner.mjs"), RUNNER);
        const packages = importedPackages(module);
        yield* fs.writeFileString(
          path.join(directory, "package.json"),
          toJson({ name: "signalbox-automation", private: true, type: "module" }),
        );
        if (packages.length > 0) {
          const installer = yield* packageInstaller;
          const installed = yield* processes.run({
            command: installer.command,
            args: [...installer.args, ...packages],
            cwd: directory,
            env,
            timeout: INSTALL_TIMEOUT,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            outputMode: "truncate",
          });
          if (installed.code !== 0) {
            return yield* fail(
              `Installing ${packages.join(", ")} failed:\n${installed.stderr.slice(-2000)}`,
            );
          }
        }
        yield* fs.writeFileString(marker, packages.join("\n"));
      }),
    );

  const automationDirectory = (automationId: string) =>
    path.join(config.stateDir, "automations", automationId);

  /** Runs `name(...args)` from the version's run module. `cwd` is where the function runs, normally the project. */
  const run = (input: {
    readonly automationId: string;
    readonly version: number;
    readonly module: string | null;
    readonly name: string;
    readonly args: ReadonlyArray<unknown>;
    readonly cwd: string;
    readonly resultName: string;
  }) =>
    Effect.gen(function* () {
      if (input.module === null)
        return yield* fail(`${input.name} isn't a w.run function in this automation.`);
      const node = yield* resolveNodeExecutable("Automations");
      const host = yield* HostProcess.Environment;
      const env = minimalEnvironment(host);
      const directory = path.join(automationDirectory(input.automationId), `v${input.version}`);
      yield* ensureInstalled(directory, input.module, { ...env, ...installVariables(host) });
      const resultPath = path.join(
        directory,
        "results",
        `${input.resultName.replace(/[^A-Za-z0-9_.-]+/g, "_")}.json`,
      );
      yield* fs.makeDirectory(path.dirname(resultPath), { recursive: true });
      yield* fs.remove(resultPath, { force: true });
      const ran = yield* processes.run({
        command: node,
        args: [path.join(directory, "runner.mjs")],
        cwd: input.cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdin: toJson({
          modulePath: path.join(directory, "automation.mjs"),
          name: input.name,
          args: input.args,
          resultPath,
        }),
        timeout: RUN_TIMEOUT,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "truncate",
      });
      if (!(yield* fs.exists(resultPath))) {
        return yield* fail(
          `${input.name} exited (code ${String(ran.code)}) without a result:\n${ran.stderr.slice(-2000)}`,
        );
      }
      const result = fromJson(yield* fs.readFileString(resultPath)) as {
        ok: boolean;
        value?: unknown;
        error?: string;
      };
      yield* fs.remove(resultPath, { force: true });
      if (!result.ok) return yield* fail(result.error ?? `${input.name} failed.`);
      return result.value ?? null;
    }).pipe(
      Effect.provideContext(services),
      Effect.mapError((cause) =>
        isAutomationError(cause)
          ? cause
          : automationError(`w.run failed: ${errorMessage(cause)}`, { cause }),
      ),
    );

  return {
    run,
    /** Deletes everything the automation installed. */
    remove: (automationId: string) =>
      fs.remove(automationDirectory(automationId), { recursive: true, force: true }),
    /** Deletes installed versions other than `keep`: the current one and those runs still use. */
    prune: (automationId: string, keep: ReadonlySet<number>) =>
      Effect.gen(function* () {
        const directory = automationDirectory(automationId);
        if (!(yield* fs.exists(directory))) return;
        for (const entry of yield* fs.readDirectory(directory)) {
          const version = /^v(\d+)$/.exec(entry)?.[1];
          if (version === undefined || keep.has(Number(version))) continue;
          yield* fs.remove(path.join(directory, entry), { recursive: true, force: true });
        }
      }),
  };
});

/** What the subprocess may see of the server's environment. Provider keys and NODE_OPTIONS stay out. */
const PASSED_VARIABLES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows needs these to start processes and find the user's folders.
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]);
/** Installs also need the network setup and package manager config. */
const INSTALL_VARIABLE =
  /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|npm_config_.*|NPM_CONFIG_.*|PNPM_HOME|XDG_.*)$/;

/**
 * The environment for `w.run` processes. The process runner merges `env`
 * over the server's own environment, and Node leaves out variables set to
 * undefined, so every other variable is masked here.
 */
function minimalEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of new Set([...Object.keys(host), ...Object.keys(NodeProcess.env)])) {
    env[name] = PASSED_VARIABLES.has(name) ? host[name] : undefined;
  }
  return env;
}

function installVariables(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passed: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(host)) {
    if (INSTALL_VARIABLE.test(name)) passed[name] = host[name];
  }
  return passed;
}
