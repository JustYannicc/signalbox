import type { collectCombinedQualification } from "./combinedQualification.ts";
import {
  ClaudeQualificationModelPeer,
  CLAUDE_QUALIFICATION_PROMPTS,
} from "./fixture/claudeModelPeer.ts";
import { createClaudeWorkloadTransport } from "./fixture/claudeModelTransport.ts";
import type { ClaudePersistedModelRecord } from "./fixture/claudeModelEvidence.ts";
import { claudeLane } from "./fixture/claudeCTransport.ts";
import { CLAUDE_WORKLOAD_ACTIONS } from "./claudeCollector.ts";
import { sha256 } from "./fixture/common.ts";

export async function combinedEvidenceFixture() {
  const model = "synthetic-model";
  const collectorNonce = "synthetic-collector";
  const mcpProbe = {
    toolName: "mcp__executor__qualification_echo",
    input: { text: "echo" },
    expectedText: "echo",
  };
  const runId = "00000000-0000-4000-8000-000000000001";
  const artifacts = new Map<string, Uint8Array>();
  const reference = (id: string) => ({ id, bytes: 1, sha256: "a".repeat(64) });
  const timing = {
    label: "cold first-successful-RPC latency",
    interpretation: "startup upper bound",
    clock: "parent process.hrtime.bigint",
    startedMonotonicNs: "1000000",
    finishedMonotonicNs: "2000000",
    milliseconds: 1,
    includesRpc: true,
    exactBootTime: false,
  };
  const prepared = {
    artifact: {
      provider: "claude-code",
      releaseId: "synthetic",
      artifactHash: "a".repeat(64),
      artifactRef: `sha256:${"a".repeat(64)}`,
      sourceIdentity: "b".repeat(64),
      fixtureIdentity: "synthetic",
      createdAt: "2026-10-30T00:00:00Z",
    },
    plan: {
      release: {
        harness: "claude-code",
        version: "synthetic",
        manifestSha256: "a".repeat(64),
        modules: {},
      },
      sourceIdentity: "b".repeat(64),
      computer: { sourceIdentity: "c".repeat(64), manifestSha256: "d".repeat(64) },
      preparedModules: {},
    },
  };
  const variant = async (name: "baseline" | "hooks") => {
    const lane = claudeLane(runId, name);
    const peer = new ClaudeQualificationModelPeer({ model, collectorNonce, mcpProbe });
    const modelRecords: ClaudePersistedModelRecord[] = [];
    let workflowPhase: "work" | "resume" | "finish" = "work";
    const transport = createClaudeWorkloadTransport({
      collectorNonce,
      apiRevision: "EC1APIr2",
      fetch: (request) => peer.fetch(request),
      modelEvidence: () => peer.snapshot(),
      record: async (record, wire) => {
        const artifact = wire
          ? {
              id: `${name}/${record.ordinal}/${record.phase}`,
              bytes: wire.length,
              sha256: await sha256(wire),
            }
          : undefined;
        if (wire && artifact) artifacts.set(artifact.id, wire.slice());
        modelRecords.push({
          ...record,
          runId: lane.runId,
          publicRequestId: `${name}-${workflowPhase}`,
          variant: name,
          workflowPhase,
          ...(artifact ? { artifact } : {}),
        });
      },
    });
    const messages: unknown[] = [{ role: "user", content: CLAUDE_QUALIFICATION_PROMPTS.work }];
    const request = (signal?: AbortSignal) =>
      new Request("https://model.invalid/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model,
          max_tokens: 128,
          messages,
          tools: [{ name: mcpProbe.toolName, input_schema: { type: "object" } }],
        }),
        ...(signal ? { signal } : {}),
      });
    const results = [
      "Success",
      "before\n",
      "Updated",
      "sb1070-claude-bash-marker",
      "/workspace/claude-qualification.txt:1:after",
      "echo",
    ];
    for (const result of results) {
      const response = (await (await transport(request())).json()) as {
        content: Array<{ type: string; id?: string; name?: string; [key: string]: unknown }>;
      };
      const call = response.content.find((item: { type: string }) => item.type === "tool_use");
      messages.push(
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call?.id, content: result }],
        },
      );
    }
    await transport(request());
    workflowPhase = "resume";
    messages.push({ role: "user", content: CLAUDE_QUALIFICATION_PROMPTS.resume });
    await transport(request());
    workflowPhase = "finish";
    messages.push({ role: "user", content: CLAUDE_QUALIFICATION_PROMPTS.finish });
    await transport(request());
    const identity = (replacement: boolean) => ({
      loaderId: `${name}-loader-${replacement ? 2 : 1}`,
      incarnationNonce: `${name}-facet-${replacement ? 2 : 1}`,
    });
    const turn = (phase: "work" | "resume" | "finish") => {
      const requestId = `${name}-${phase}`;
      const checkpoint = {
        native: reference(`${requestId}-native`),
        filesystem: reference(`${requestId}-files`),
      };
      return {
        phase,
        loadedPreparedRelease: prepared,
        requestId,
        status: "committed",
        runStore: {
          snapshot: {
            seed: { identity: { runId: lane.runId } },
            requests: {
              entries: [
                {
                  request: { requestId },
                  status: "completed",
                  finish: { status: "completed", checkpoint },
                },
              ],
            },
          },
        },
        files: {
          checkpointId: checkpoint.filesystem.id,
          files: [
            {
              path: "claude-qualification.txt",
              mode: 0o644,
              bytes: new TextEncoder().encode("after\n"),
            },
          ],
        },
        commit: { status: "committed" },
        shard: {
          processes: [
            {
              processId: lane.processId,
              status: phase === "work" ? "settled" : "idle",
              identity: identity(phase !== "work"),
            },
          ],
        },
        terminal: { requestId, nativeSessionId: `${name}-native`, status: "completed" },
      };
    };
    const publicRunPin = {
      identity: `${name}-facet`,
      entrypoint: "ClaudeFacet",
      tag: "public-run",
      route: { method: "POST", path: `/claude/${name}/work/dispatch` },
      invocationId: `${name}-work`,
    };
    const actionPins = CLAUDE_WORKLOAD_ACTIONS.map((action) => ({
      action,
      identity: `${name}-${action}`,
      entrypoint: "default",
      tag: action,
      route: { method: "POST", path: `/${action}` },
      invocationId: `${name}-action-${action}`,
    }));
    const event = (pin: typeof publicRunPin, milestone: "entered" | "terminal") => ({
      schema: "sb1070/producer/v1",
      runId,
      producerClass: "dynamic-worker",
      workerId: pin.identity,
      milestone,
      isolateNonce: `${name}-nonce`,
      ...pin,
    });
    return {
      workflow: {
        variant: name,
        lane,
        firstPublicCall: "startFreshProcess",
        turns: [turn("work"), turn("resume"), turn("finish")],
        replacement: {
          resumed: { status: "resumed", identity: identity(true) },
          oldControllerDenied: true,
          oldRelease: { sequence: 1 },
          publication: { sequence: 2 },
        },
        completion: {
          creation: { nativeSessionId: `${name}-native` },
          nativeSessionId: `${name}-native`,
          completedTurns: 3,
          replacementCount: 1,
          ownership: { writer: null, leases: 0 },
          evidence: {
            terminal: [
              {
                value: {
                  nativeSessionId: `${name}-native`,
                  stopped: true,
                  joined: { invocationRpc: true, fetch: true, ports: true },
                },
              },
            ],
          },
        },
      },
      workload: {
        classification: "synthetic",
        scenario: name,
        runId,
        requestId: `${name}-work`,
        coldStartupUpperBound: timing,
        turn: {
          requestId: `${name}-work`,
          status: "completed",
          input: reference("input"),
          result: reference("result"),
          checkpoint: { native: reference("native"), filesystem: reference("files") },
        },
        expectedPreparedRelease: prepared,
        loadedPreparedRelease: prepared,
        moduleInitNonceBefore: `${name}-nonce`,
        moduleInitNonceAfter: `${name}-nonce`,
        publicRunPin,
        actionPins,
        observerTrace: {
          producerEvents: [
            event(publicRunPin, "entered"),
            ...actionPins.flatMap((pin) => [event(pin, "entered"), event(pin, "terminal")]),
            event(publicRunPin, "terminal"),
          ],
          observerFailures: [],
        },
      },
      modelRecords,
    };
  };
  const input = {
    runId,
    classification: "synthetic",
    collectorNonce,
    model,
    mcpProbe,
    codex: {
      completedTurns: 3,
      replacementCount: 1,
      nativeSessionId: "codex-native",
      model: { complete: { completedTurns: 3, replacements: 1, nativeSessionId: "codex-native" } },
      ownership: { writer: null, leases: 0 },
      evidence: {
        terminal: [1, 2, 3].map(() => ({
          value: {
            nativeSessionId: "codex-native",
            stopped: true,
            joined: { invocationRpc: true, fetch: true, ports: true },
          },
        })),
      },
    },
    claude: { baseline: await variant("baseline"), hooks: await variant("hooks") },
    readArtifact: async (reference: { id: string }) => {
      const bytes = artifacts.get(reference.id);
      if (!bytes) throw new Error("Missing synthetic wire");
      return bytes.slice();
    },
  };
  // The missing fields are unused product receipt metadata, never runtime or qualification proof.
  return input as unknown as Parameters<typeof collectCombinedQualification>[0];
}
