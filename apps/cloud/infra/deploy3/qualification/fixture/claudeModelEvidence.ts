import type { ClaudeMcpProbe } from "./claudeMcpProbe.ts";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import { CLAUDE_QUALIFICATION_PROMPTS } from "./claudeModelPeer.ts";
import { replayClaudeModel } from "./claudeModelReplay.ts";
import type { ClaudeWorkloadRecord } from "./claudeModelTransport.ts";
import { sha256 } from "./common.ts";

export interface ClaudePersistedModelRecord extends ClaudeWorkloadRecord {
  readonly artifact?: HarnessRunArtifact;
}

export interface ClaudeModelWorkloadEvidence {
  readonly schema: "signalbox/claude-qualification-model-workload/v1";
  readonly purpose: "qualification";
  readonly apiRevision: "EC1APIr2";
  readonly collectorNonce: string;
  readonly model: string;
  readonly mcpProbe: ClaudeMcpProbe;
  readonly status: "observed";
  readonly qualification: "pending";
  readonly exchangeCount: number;
  readonly records: readonly {
    readonly ordinal: number;
    readonly request: HarnessRunArtifact;
    readonly response?: HarnessRunArtifact;
    readonly failure?: string;
  }[];
  readonly toolResults: readonly {
    readonly ordinal: number;
    readonly name: string;
    readonly toolUseId: string;
    readonly resultText: string;
  }[];
  readonly criteria: readonly {
    readonly name: "text" | "readEdit" | "bash" | "grep" | "mcp" | "resume" | "interrupt";
    readonly status: "observed";
  }[];
}

/** Verifies persisted Messages API bytes and deterministic peer tool-result checks. */
export async function collectClaudeModelWorkloadEvidence(input: {
  readonly records: readonly ClaudePersistedModelRecord[];
  readonly readArtifact: (reference: HarnessRunArtifact) => Promise<Uint8Array>;
  readonly collectorNonce: string;
  readonly model: string;
  readonly mcpProbe: ClaudeMcpProbe;
}): Promise<ClaudeModelWorkloadEvidence> {
  if (!input.collectorNonce.trim() || !input.model.trim())
    throw new Error("CLAUDE_QUALIFICATION_MODEL_IDENTITY_MISSING");
  const requests = new Map<number, ClaudePersistedModelRecord>();
  const terminals = new Map<number, ClaudePersistedModelRecord>();
  const responseTexts: string[] = [];
  const requestKinds = new Set<string>();
  for (const record of input.records) {
    if (
      record.purpose !== "qualification" ||
      record.apiRevision !== "EC1APIr2" ||
      record.collectorNonce !== input.collectorNonce ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal < 1
    )
      throw new Error("CLAUDE_QUALIFICATION_MODEL_RECORD_IDENTITY_INVALID");
    if (record.phase === "request") {
      if (requests.has(record.ordinal) || !record.artifact)
        throw new Error("CLAUDE_QUALIFICATION_MODEL_REQUEST_RECORD_INVALID");
      const bytes = await input.readArtifact(record.artifact);
      if (
        bytes.byteLength !== record.artifact.bytes ||
        (await sha256(bytes)) !== record.artifact.sha256 ||
        bytes.byteLength !== record.bodyBytes ||
        (await sha256(bytes)) !== record.bodySha256 ||
        record.wireBytes !== record.bodyBytes ||
        record.wireSha256 !== record.bodySha256
      )
        throw new Error("CLAUDE_QUALIFICATION_MODEL_REQUEST_WIRE_MISMATCH");
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<
        string,
        unknown
      >;
      if (body.model !== input.model || !Array.isArray(body.messages))
        throw new Error("CLAUDE_QUALIFICATION_MODEL_REQUEST_CONTENT_INVALID");
      const lastUser = body.messages
        .toReversed()
        .find((message) => asRecord(message)?.role === "user");
      const lastUserText = messageText(asRecord(lastUser)?.content);
      if (lastUserText.includes(CLAUDE_QUALIFICATION_PROMPTS.work)) requestKinds.add("work");
      if (lastUserText.includes(CLAUDE_QUALIFICATION_PROMPTS.resume)) requestKinds.add("resume");
      if (lastUserText.includes(CLAUDE_QUALIFICATION_PROMPTS.interrupt))
        requestKinds.add("interrupt");
      requests.set(record.ordinal, record);
    } else if (record.phase === "response" || record.phase === "failure") {
      if (terminals.has(record.ordinal))
        throw new Error("CLAUDE_QUALIFICATION_MODEL_TERMINAL_DUPLICATE");
      if (record.phase === "response") {
        if (!record.artifact || record.status !== 200 || !record.wireSha256)
          throw new Error("CLAUDE_QUALIFICATION_MODEL_RESPONSE_RECORD_INVALID");
        const bytes = await input.readArtifact(record.artifact);
        if (
          bytes.byteLength !== record.artifact.bytes ||
          (await sha256(bytes)) !== record.artifact.sha256 ||
          bytes.byteLength !== record.wireBytes ||
          (await sha256(bytes)) !== record.wireSha256
        )
          throw new Error("CLAUDE_QUALIFICATION_MODEL_RESPONSE_WIRE_MISMATCH");
        responseTexts.push(...responseText(bytes, record.contentType ?? ""));
      } else if (record.failure !== "aborted" || record.modelEvidence === undefined) {
        throw new Error("CLAUDE_QUALIFICATION_MODEL_FAILURE_INVALID");
      }
      terminals.set(record.ordinal, record);
    }
  }
  if (requests.size === 0 || requests.size !== terminals.size)
    throw new Error("CLAUDE_QUALIFICATION_MODEL_EXCHANGE_INCOMPLETE");
  for (let ordinal = 1; ordinal <= requests.size; ordinal++)
    if (!requests.has(ordinal) || !terminals.has(ordinal))
      throw new Error("CLAUDE_QUALIFICATION_MODEL_EXCHANGE_GAP");

  const snapshot = await replayClaudeModel({
    model: input.model,
    collectorNonce: input.collectorNonce,
    mcpProbe: input.mcpProbe,
    exchanges: [...requests]
      .sort(([left], [right]) => left - right)
      .map(([ordinal, request]) => ({ request, terminal: terminals.get(ordinal)! })),
    readArtifact: input.readArtifact,
  });
  const actions = new Map(snapshot.toolEvidence.map((item) => [item.name, item]));
  const mcp = snapshot.toolEvidence.find((item) => item.name.startsWith("mcp__executor__"));
  if (
    !snapshot.workCompleted ||
    !snapshot.resumeCompleted ||
    snapshot.interruptedRequests !== 1 ||
    snapshot.interruptRequests !== 1 ||
    !actions.has("Write") ||
    !actions.has("Read") ||
    !actions.has("Edit") ||
    !actions.has("Bash") ||
    !actions.has("Grep") ||
    !mcp ||
    !snapshot.toolEvidence.some((item) => item.resultText.includes("sb1070-claude-bash-marker")) ||
    !snapshot.toolEvidence.some(
      (item) => item.name === "Grep" && item.resultText.includes("claude-qualification.txt"),
    )
  )
    throw new Error("CLAUDE_QUALIFICATION_MODEL_SEMANTIC_EVIDENCE_MISSING");
  if (["work", "resume", "interrupt"].some((phase) => !requestKinds.has(phase)))
    throw new Error("CLAUDE_QUALIFICATION_MODEL_PHASE_REQUEST_MISSING");
  if (
    !responseTexts.some((text) =>
      text.includes("I will create, edit, inspect, and verify the file."),
    ) ||
    !responseTexts.some((text) => text.includes("sb1070-claude-workflow-complete")) ||
    !responseTexts.some((text) => text.includes("sb1070-claude-resume-observed"))
  )
    throw new Error("CLAUDE_QUALIFICATION_MODEL_TEXT_RESULT_MISSING");
  const failedInterrupt = [...terminals.values()].some(
    (record) => record.phase === "failure" && record.failure === "aborted",
  );
  if (!failedInterrupt) throw new Error("CLAUDE_QUALIFICATION_MODEL_INTERRUPT_MISSING");

  return {
    schema: "signalbox/claude-qualification-model-workload/v1",
    purpose: "qualification",
    apiRevision: "EC1APIr2",
    collectorNonce: input.collectorNonce,
    model: input.model,
    mcpProbe: input.mcpProbe,
    status: "observed",
    qualification: "pending",
    exchangeCount: requests.size,
    records: [...requests].map(([ordinal, request]) => {
      const terminal = terminals.get(ordinal)!;
      return {
        ordinal,
        request: request.artifact!,
        ...(terminal.phase === "response" ? { response: terminal.artifact! } : {}),
        ...(terminal.phase === "failure" ? { failure: terminal.failure } : {}),
      };
    }),
    toolResults: snapshot.toolEvidence,
    criteria: ["text", "readEdit", "bash", "grep", "mcp", "resume", "interrupt"].map((name) => ({
      name: name as ClaudeModelWorkloadEvidence["criteria"][number]["name"],
      status: "observed" as const,
    })),
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const part = asRecord(item);
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("\n");
}

function responseText(bytes: Uint8Array, contentType: string): string[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!contentType.includes("text/event-stream")) {
    const body = JSON.parse(source);
    return Array.isArray(asRecord(body)?.content)
      ? (asRecord(body)!.content as unknown[]).flatMap((item) => {
          const block = asRecord(item);
          return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
        })
      : [];
  }
  const values: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = asRecord(JSON.parse(line.slice(6)));
    if (data?.type === "content_block_delta") {
      const delta = asRecord(data.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") values.push(delta.text);
    }
  }
  return values;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
