// oxlint-disable-next-line typescript/triple-slash-reference -- Asset types must follow this module into the infrastructure typecheck.
/// <reference path="./compilerAssets.d.ts" />
import type { CompileForCloudResult } from "@signalbox/automation-compiler/forCloud";
import type {
  WorkflowPlan,
  WorkflowPreparation,
} from "@signalbox/automation-compiler/workflowPhases";

import parserSource from "../../.generated/automation-compiler/parser.txt";
import parserBytes from "../../.generated/automation-compiler/parser.bin";
import transformerSource from "../../.generated/automation-compiler/transformer.txt";
import transformerBytes from "../../.generated/automation-compiler/transformer.bin";
import ids from "../../.generated/automation-compiler/ids.json" with { type: "json" };
import { COMPATIBILITY_DATE } from "../../infra/stage.ts";

interface Parser {
  prepare(source: string): Promise<WorkflowPreparation>;
  memoryBytes(): Promise<number>;
}
interface Transformer {
  finish(plan: WorkflowPlan): Promise<CompileForCloudResult>;
  memoryBytes(): Promise<number>;
}

const bytes = (value: ArrayBuffer | Uint8Array): ArrayBuffer =>
  value instanceof Uint8Array ? new Uint8Array(value).buffer : value;

/**
 * Cloudflare's 128 MiB cap includes JS and WASM. Each OXC module needs about
 * 61.4 MiB before JS, and dispose retains its memory closure. Two cached isolates
 * are the memory boundary; the UserObject only passes plain phase data between them.
 * IDs hash code AND WASM, so a warm worker can never serve a different compiler build.
 */
export function makeDistributedCompiler(loader: WorkerLoader | undefined) {
  const entry = (
    phase: "parser" | "transformer",
    source: string,
    wasm: ArrayBuffer | Uint8Array,
  ) => {
    if (loader === undefined) throw new Error("This cloud has no compiler Worker Loader binding.");
    return loader.get(`automation-compiler/${phase}/${ids[phase]}`, () => ({
      compatibilityDate: COMPATIBILITY_DATE,
      mainModule: "compiler.js",
      modules: { "compiler.js": source, "oxc.wasm": { wasm: bytes(wasm) } },
      globalOutbound: null,
    }));
  };
  const parser = () =>
    entry("parser", parserSource, parserBytes).getEntrypoint("Parser") as unknown as Parser;
  const transformer = () =>
    entry("transformer", transformerSource, transformerBytes).getEntrypoint(
      "Transformer",
    ) as unknown as Transformer;
  return {
    compile: async (source: string): Promise<CompileForCloudResult> => {
      const prepared = await parser().prepare(source);
      return prepared.ok ? transformer().finish(prepared.plan) : prepared;
    },
    /** Linear memory per isolate, for the finite runtime proof. This excludes JS heap. */
    memoryBytes: async () => ({
      parser: await parser().memoryBytes(),
      transformer: await transformer().memoryBytes(),
    }),
  };
}
