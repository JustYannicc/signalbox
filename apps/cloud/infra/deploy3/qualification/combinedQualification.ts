import * as Schema from "effect/Schema";
import type { Lifecycle } from "./fixture/lifecycle.ts";
import { CLAUDE_THREAD_ROUTE } from "./fixture/claudeDispatch.ts";
import { classifyV8Termination, type V8TerminationEvidence } from "./termination.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));
const ClaudeThreadReceipt = Schema.Struct({
  schema: Schema.Literal("signalbox/claude-qualification-thread/v1"),
  runId: NonEmpty,
  status: Schema.Literal("completed"),
  result: Schema.Struct({
    completed: Schema.Literal(true),
    turns: Schema.Array(Schema.Struct({ runId: NonEmpty, status: Schema.Literal("completed") })),
    model: Schema.Struct({
      collectorNonce: NonEmpty,
      model: NonEmpty,
      workCompleted: Schema.Literal(true),
      resumeCompleted: Schema.Literal(true),
      toolEvidence: Schema.Array(Schema.Struct({ name: NonEmpty, resultText: NonEmpty })),
    }),
  }),
});
const KernelGrep = Schema.Struct({
  runId: NonEmpty,
  invocationId: NonEmpty,
  route: Schema.Struct({ method: Schema.Literal("POST"), path: Schema.String }),
  executable: Schema.Literal("/bin/rg"),
  exit: Schema.Struct({ exitCode: Schema.Number }),
});
const decodeReceipt = Schema.decodeUnknownSync(ClaudeThreadReceipt);
const isKernelGrep = Schema.is(KernelGrep);

/** Joins Codex's completed sequence to the Claude thread step's two completed product turns. */
export async function collectCombinedQualification(input: {
  readonly runId: string;
  readonly classification: "synthetic" | "official";
  readonly collectorNonce: string;
  readonly model: string;
  readonly codex: Awaited<ReturnType<Lifecycle["finish"]>>;
  readonly claude: {
    /** The persisted receipt of `${CLAUDE_THREAD_ROUTE}`. */
    readonly receipt: unknown;
    /** Payloads of kernel-rg-completed from the same run's exported journal. */
    readonly kernelInvocations: readonly unknown[];
  };
  readonly termination?: V8TerminationEvidence;
}) {
  const codex = input.codex;
  if (
    !input.runId ||
    codex.completedTurns !== 3 ||
    codex.replacementCount !== 1 ||
    codex.model.complete.completedTurns !== 3 ||
    codex.model.complete.replacements !== 1 ||
    codex.model.complete.nativeSessionId !== codex.nativeSessionId ||
    codex.ownership.writer !== null ||
    codex.ownership.leases !== 0 ||
    codex.evidence.terminal.length !== 3 ||
    codex.evidence.terminal.some(
      ({ value }) =>
        value.nativeSessionId !== codex.nativeSessionId ||
        !value.stopped ||
        !value.joined.invocationRpc ||
        !value.joined.fetch ||
        !value.joined.ports,
    )
  )
    throw new Error("DEPLOY3_COMBINED_CODEX_COMPLETION_INVALID");
  const receipt = decodeReceipt(input.claude.receipt);
  const { turns, model } = receipt.result;
  const tools = model.toolEvidence.map((tool) => tool.name);
  const grep = input.claude.kernelInvocations.find(
    (invocation) =>
      isKernelGrep(invocation) &&
      invocation.runId === input.runId &&
      invocation.route.path === CLAUDE_THREAD_ROUTE &&
      invocation.exit.exitCode === 0,
  );
  if (
    receipt.runId !== input.runId ||
    turns.length !== 2 ||
    turns[0]!.runId === turns[1]!.runId ||
    model.collectorNonce !== input.collectorNonce ||
    model.model !== input.model ||
    !tools.includes("Read") ||
    !tools.includes("Grep") ||
    !isKernelGrep(grep)
  )
    throw new Error("DEPLOY3_COMBINED_CLAUDE_THREAD_INVALID");
  const claude = {
    runs: turns.map((turn) => turn.runId),
    tools,
    kernelGrep: grep.invocationId,
    criteria: [
      {
        name: "thread",
        status: "observed" as const,
        detail: "Two product thread turns completed on one thread through its public objects.",
      },
      {
        name: "grep",
        status: "observed" as const,
        detail: "Grep's kernel ripgrep invocation succeeded under the Claude thread route.",
      },
    ],
  };
  const termination = input.termination
    ? classifyV8Termination(input.termination)
    : "NO_VERIFIED_TERMINATION";
  return {
    schema: "signalbox/deploy3-combined-qualification-result/v1",
    runId: input.runId,
    classification: input.classification,
    status: "observed",
    apiRevision: "EC1APIr2",
    codex,
    claude,
    termination,
    qualification: "pending",
    deploymentReady: false,
    blockers: [
      ...(input.classification === "synthetic"
        ? ["Synthetic inputs cannot qualify an official release."]
        : []),
      "Deployed workload completion and unchanged module-init nonce are required for platform policy compliance evidence.",
    ],
  } as const;
}
