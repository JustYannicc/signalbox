// @effect-diagnostics nodeBuiltinImport:off - Standalone compiler and LSP proof.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";
import getExePath from "@effect/tsgo/lib/getExePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  LspSmokeClient,
  isShutdownCancellation,
  type JsonRpcMessage,
} from "./lib/lsp-smoke-client.ts";

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type DiagnosticMode = "pull" | "push";
type Diagnostic = {
  code?: number | string;
  message: string;
  range: Range;
  source?: string;
};
type Compiler = "effect-tsgo" | "tsc-rs";
type HostRuntime = {
  arguments: ReadonlyArray<string>;
  platform: NodeJS.Platform;
  workingDirectory: string;
};
type InitializeResult = {
  capabilities?: { diagnosticProvider?: unknown };
};
export type LspSmokeResult = {
  compiler: Compiler;
  definitionFound: boolean;
  diagnosticMode: DiagnosticMode;
  effectDiagnostic: Diagnostic;
  lspExitCode: number | null;
  lspExitSignal: NodeJS.Signals | null;
  peakRssBytes: number | null;
  shutdownError: string | null;
  shutdownResponseReceived: boolean;
  typescriptDiagnostic: Diagnostic;
  wallMs: number;
};

const sessionBudgetMs = 90_000;
const pairBudgetMs = 180_000;
const fixtureText = [
  'import * as nodeFs from "node:fs";',
  "export type LspDefinition = string;",
  "export const plantedTypeError: LspDefinition = 42;",
  'export const fileContents = nodeFs.readFileSync("package.json", "utf8");',
  "",
].join("\n");

async function hostRuntime(): Promise<HostRuntime> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return {
        arguments: yield* HostProcess.Arguments,
        platform: yield* HostProcess.Platform,
        workingDirectory: yield* HostProcess.WorkingDirectory,
      };
    }),
  );
}

function compilerPath(compiler: Compiler, workspaceRoot: string, platform: NodeJS.Platform) {
  if (compiler === "effect-tsgo") return NodeFS.realpathSync(getExePath());
  const name = platform === "win32" ? "tsc.exe" : "tsc";
  const path = NodePath.join(workspaceRoot, ".generated/tsc-rs-sdk", name);
  NodeFS.accessSync(path);
  return path;
}

function isDefinition(value: unknown, fixtureUri: string) {
  const locations = Array.isArray(value) ? value : value ? [value] : [];
  return locations.some((location) => {
    if (typeof location !== "object" || location === null) return false;
    const item = location as {
      range?: Range;
      targetRange?: Range;
      targetUri?: string;
      uri?: string;
    };
    return (
      (item.uri ?? item.targetUri) === fixtureUri &&
      (item.range ?? item.targetRange)?.start.line === 1
    );
  });
}

function diagnostics(message: JsonRpcMessage): Diagnostic[] {
  return (message.params as { diagnostics?: Diagnostic[] } | undefined)?.diagnostics ?? [];
}

function pullDiagnostics(value: unknown): Diagnostic[] {
  if (typeof value !== "object" || value === null) return [];
  const report = value as { items?: Diagnostic[]; kind?: string };
  return report.kind === "full" && Array.isArray(report.items) ? report.items : [];
}

function effectDiagnostic(items: Diagnostic[]) {
  return items.find((diagnostic) => {
    if (diagnostic.range.start.line !== 0) return false;
    return /effect|nodeBuiltinImport/i.test(
      `${diagnostic.source ?? ""} ${String(diagnostic.code ?? "")} ${diagnostic.message}`,
    );
  });
}

async function runSession(
  compiler: Compiler,
  compilerRoot: string,
  workspaceRoot: string,
  platform: NodeJS.Platform,
  fixturePath: string,
  deadlineAt: number,
  expectedDiagnosticMode?: DiagnosticMode,
): Promise<LspSmokeResult> {
  const startedAt = NodePerfHooks.performance.now();
  const fixtureUri = NodeURL.pathToFileURL(fixturePath).href;
  const workspaceUri = NodeURL.pathToFileURL(workspaceRoot).href;
  const client = LspSmokeClient.spawn(
    compilerPath(compiler, compilerRoot, platform),
    ["--lsp", "--stdio"],
    workspaceRoot,
    platform,
    Math.min(deadlineAt, startedAt + sessionBudgetMs),
  );
  try {
    const initialization = (await client.request("initialize", {
      processId: null,
      rootUri: workspaceUri,
      workspaceFolders: [{ uri: workspaceUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor"] } },
          },
          diagnostic: { relatedInformation: true },
          definition: { linkSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        },
      },
    })) as InitializeResult;
    if (typeof initialization !== "object" || initialization === null) {
      throw new Error("LSP initialize returned no capabilities");
    }
    const diagnosticMode = initialization.capabilities?.diagnosticProvider ? "pull" : "push";
    client.recordEvent(
      `initialize advertised diagnosticProvider=${diagnosticMode === "pull"}; mode=${diagnosticMode}`,
    );
    if (expectedDiagnosticMode && diagnosticMode !== expectedDiagnosticMode) {
      throw new Error(
        `LSP diagnostic protocol differs: expected=${expectedDiagnosticMode}, actual=${diagnosticMode}`,
      );
    }
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: fixtureUri,
        languageId: "typescript",
        version: 1,
        text: fixtureText,
      },
    });
    const items =
      diagnosticMode === "pull"
        ? pullDiagnostics(
            await client.request("textDocument/diagnostic", {
              textDocument: { uri: fixtureUri },
            }),
          )
        : diagnostics(
            await client.waitForNotification(
              "textDocument/publishDiagnostics",
              (params) => (params as { uri?: string } | undefined)?.uri === fixtureUri,
            ),
          );
    const typescriptDiagnostic = items.find((diagnostic) => Number(diagnostic.code) === 2322);
    if (!typescriptDiagnostic) {
      throw new Error("LSP did not report the planted TypeScript 2322 error");
    }
    const effect = effectDiagnostic(items);
    if (!effect) throw new Error("LSP did not report the Effect nodeBuiltinImport diagnostic");

    const definition = await client.request("textDocument/definition", {
      textDocument: { uri: fixtureUri },
      position: {
        line: 2,
        character: fixtureText.split("\n")[2]!.indexOf("LspDefinition") + 1,
      },
    });
    const shutdown = await client.shutdown();
    // Both native servers can report cancellation after acknowledging LSP shutdown.
    // Keep that exit status in the measurements; a crash or missing acknowledgement fails.
    const cancelledAfterShutdown =
      shutdown.code === 1 && isShutdownCancellation(client.shutdownStderr());
    if (!shutdown.responseReceived || (shutdown.error && !cancelledAfterShutdown)) {
      throw new Error(shutdown.error ?? "The LSP did not acknowledge shutdown");
    }

    return {
      compiler,
      definitionFound: isDefinition(definition, fixtureUri),
      diagnosticMode,
      effectDiagnostic: effect,
      lspExitCode: shutdown.code,
      lspExitSignal: shutdown.signal,
      peakRssBytes: client.peakRssBytes(),
      shutdownError: shutdown.error,
      shutdownResponseReceived: shutdown.responseReceived,
      typescriptDiagnostic,
      wallMs: NodePerfHooks.performance.now() - startedAt,
    };
  } catch (error) {
    try {
      await client.terminate();
    } catch (cleanupError) {
      throw new LspSmokeProcessError(
        `${error instanceof Error ? error.message : String(error)}; spawned LSP process did not stop: ${String(cleanupError)}`,
        false,
      );
    }
    const detail = client.stderr().trim().slice(-2_000);
    const trace = client.protocolTrace();
    throw new LspSmokeProcessError(
      `${error instanceof Error ? error.message : String(error)}\nLSP protocol trace:\n${trace}${detail ? `\nstderr: ${detail}` : ""}`,
      true,
    );
  }
}

class LspSmokeProcessError extends Error {
  readonly processStopped: boolean;

  constructor(message: string, processStopped: boolean) {
    super(message);
    this.processStopped = processStopped;
  }
}

export async function runLspSmokePair(workspaceRoot?: string) {
  const host = await hostRuntime();
  const root = workspaceRoot ?? host.workingDirectory;
  const fixturePath = NodePath.join(
    root,
    "scripts",
    `__tsc-rs-lsp-smoke-${NodeCrypto.randomUUID()}.ts`,
  );
  const deadlineAt = NodePerfHooks.performance.now() + pairBudgetMs;
  let fixtureCreated = false;
  let processStopped = true;
  try {
    NodeFS.writeFileSync(fixturePath, fixtureText, { flag: "wx" });
    fixtureCreated = true;
    const baseline = await runSession(
      "effect-tsgo",
      root,
      root,
      host.platform,
      fixturePath,
      deadlineAt,
    );
    const rust = await runSession(
      "tsc-rs",
      root,
      root,
      host.platform,
      fixturePath,
      deadlineAt,
      baseline.diagnosticMode,
    );
    if (!baseline.definitionFound || !rust.definitionFound) {
      throw new Error(
        `LSP definition lookup: baseline=${baseline.definitionFound}, rust=${rust.definitionFound}`,
      );
    }
    return { baseline, rust };
  } catch (error) {
    if (error instanceof LspSmokeProcessError && !error.processStopped) {
      processStopped = false;
      throw new LspSmokeProcessError(
        `${error.message}; fixture preserved at ${fixturePath}`,
        false,
      );
    }
    throw error;
  } finally {
    if (processStopped && fixtureCreated) {
      NodeFS.rmSync(fixturePath, { force: true });
    }
  }
}

const invocation = Effect.runSync(HostProcess.Arguments)[1];
if (
  invocation &&
  NodeFS.existsSync(invocation) &&
  NodeFS.realpathSync(invocation) === NodeURL.fileURLToPath(import.meta.url)
) {
  runLspSmokePair().then((result) => {
    NodeFS.writeSync(1, `${JSON.stringify(result, null, 2)}\n`);
    const summary =
      "LSP diagnostics and definition in the scripts project.\n\n| Compiler | Wall ms | Peak RSS bytes | Shutdown |\n| --- | ---: | ---: | --- |\n" +
      [result.baseline, result.rust]
        .map(
          (entry) =>
            `| ${entry.compiler} | ${entry.wallMs.toFixed(1)} | ${entry.peakRssBytes ?? "unmeasured"} | ${entry.shutdownError ? "server error, process stopped" : "clean"} |`,
        )
        .join("\n") +
      "\n";
    const destination = Effect.runSync(HostProcess.Environment).GITHUB_STEP_SUMMARY;
    if (destination) NodeFS.appendFileSync(destination, summary);
  });
}
