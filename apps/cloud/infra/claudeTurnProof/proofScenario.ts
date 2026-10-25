import type { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import type { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import type { MemoryFilePersistenceFixture } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import type {
  FileCommitReceipt,
  FilePersistenceResult,
} from "../../src/kernel/FilePersistencePorts.ts";
import type { MockMessagesApi } from "./mockMessages.ts";
import type { GuestObservation } from "./proofObservation.ts";
import {
  SCENARIO_SEED_FILES,
  SCENARIO_EXPECTED_FILES,
  verifyToolScenario,
} from "./toolScenario.ts";

export type ProofScenario = "boot" | "tools";
export type ContextTokenEquivalent = 50_000 | 200_000;
const base = { repository: "claude-turn-proof", fork: "proof", commit: "fixture-base" };

export function proofPrompt(
  scenario: ProofScenario,
  contextTokenEquivalent?: ContextTokenEquivalent,
) {
  const task =
    scenario === "tools"
      ? "Execute the tools requested by the mock Messages API, then reply mock."
      : "reply mock";
  if (contextTokenEquivalent === undefined)
    return { text: task, estimatedTokens: 0, paddingBytes: 0 };
  // Four ASCII bytes per token is a size estimate, not tokenizer or model evidence.
  const padding = "x ".repeat(contextTokenEquivalent * 2);
  return {
    text: `${task}\nSynthetic context padding, estimated ${contextTokenEquivalent} token equivalent:\n${padding}`,
    estimatedTokens: contextTokenEquivalent,
    paddingBytes: padding.length,
  };
}

interface ScenarioHost {
  filesystem: KernelFileSystem;
  fs: NodeFsModules;
  ports: MemoryFilePersistenceFixture;
  persistence: ReturnType<typeof createFacetFilePersistence>;
}

export function seedToolScenario(host: ScenarioHost) {
  for (const [path, text] of Object.entries(SCENARIO_SEED_FILES)) {
    const bytes = new TextEncoder().encode(text);
    host.fs.fs.writeFileSync(path, bytes);
    host.ports.seedFile(base, path, bytes);
  }
}

export function terminalSuccess(output: GuestObservation) {
  if (output.errors.length > 0 || (output.exitCode !== undefined && output.exitCode !== 0))
    return false;
  const lastLine = output.stdout.trim().split(/\r?\n/).at(-1);
  if (!lastLine) return false;
  try {
    const value: unknown = JSON.parse(lastLine);
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "result" &&
      "subtype" in value &&
      value.subtype === "success" &&
      "is_error" in value &&
      value.is_error === false
    );
  } catch {
    return false;
  }
}

export async function verifyCommittedToolScenario(
  host: ScenarioHost,
  output: GuestObservation,
  mock: MockMessagesApi,
) {
  const actualFiles: Record<string, string | undefined> = {};
  const changedInodes = [];
  for (const path of Object.keys(SCENARIO_EXPECTED_FILES)) {
    if (!host.fs.fs.existsSync(path)) {
      actualFiles[path] = undefined;
      continue;
    }
    const bytes = host.fs.fs.readFileSync(path);
    actualFiles[path] = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
    changedInodes.push({
      inode: host.filesystem.resolve(path).inode,
      paths: [path],
      removedPaths: [],
    });
  }
  let commitReceipt: FilePersistenceResult<FileCommitReceipt> | undefined;
  if (terminalSuccess(output) && mock.complete) {
    commitReceipt = await host.persistence.commitTurn({
      at: base,
      turnId: "official-claude-turn",
      changedInodes,
      signal: new AbortController().signal,
    });
  }
  const committedFiles: Record<string, Uint8Array | undefined> = {};
  if (commitReceipt?.status === "ok") {
    const tree = host.ports.inspectTree({ ...base, commit: commitReceipt.value.commit });
    for (const path of Object.keys(SCENARIO_EXPECTED_FILES))
      committedFiles[path] = tree?.[path]?.data ?? undefined;
  }
  return verifyToolScenario({
    stdout: output.stdout,
    mockComplete: mock.complete,
    toolResults: mock.toolResults,
    actualFiles,
    committedFiles,
    commitReceipt,
  });
}
