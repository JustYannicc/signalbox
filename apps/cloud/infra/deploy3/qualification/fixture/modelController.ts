import { equals } from "effect/Equal";
import {
  verifyModelPhysicalRecovery,
  type ModelRecoveryEvidence,
} from "../../../../src/harness/processResume/tests/modelPhysicalRecovery.fixture.ts";
import { createCombinedCodexModelPeer, EXPECTATIONS } from "./model/modelPeer.mjs";
import type { QualifierProof } from "./proof.ts";
import { assert, control, encoder, jsonBytes, sha256 } from "./common.ts";

export interface Incarnation {
  incarnation: string;
  loaderId: string;
  restored: boolean;
}
export class ModelController {
  readonly peer;
  #initial: Incarnation | undefined;
  #current: Incarnation | undefined;
  #nativeSessionId: string | undefined;
  #logicalReplacements = 0;
  #preparing = false;
  readonly owner: QualifierProof;
  constructor(owner: QualifierProof) {
    this.owner = owner;
    this.peer = createCombinedCodexModelPeer({
      WebSocketPair,
      persistModelRecord: async (record: Record<string, unknown>) => {
        assert(
          Number.isSafeInteger(record.sequence) && typeof record.raw === "string",
          "Model record identity is missing",
        );
        const bytes = encoder.encode(record.raw);
        assert(
          bytes.length === record.byteLengthUtf8 && (await sha256(bytes)) === record.sha256,
          "Model wire receipt changed",
        );
        const artifact = await owner.artifact(`model-raw-${record.sequence}`, bytes);
        await owner.commitModelRecord(record, artifact);
      },
      verifyNativeTerminal: async (input: {
        turn: number;
        nativeSessionId: string;
        incarnation: string;
        expectedFinalText: string;
        receipt: unknown;
      }) => {
        const receipt = await owner.knownTurn(input.turn);
        assert(
          JSON.stringify(receipt) === JSON.stringify(input.receipt),
          "Model completion selected another receipt",
        );
        assert(
          receipt.nativeSessionId === input.nativeSessionId &&
            receipt.identity.incarnationNonce === input.incarnation,
          "Model terminal belongs to another native process",
        );
        const events = await owner.runnerEvents(`turn-${input.turn}`);
        const parsed = events.map((row) => ({ ...row, item: JSON.parse(row.eventJson) }));
        const terminals = parsed.filter(
          (row) => row.item.kind === "provider" && row.item.event.type === "turn.terminal",
        );
        assert(
          terminals.length === 1 && terminals[0]!.item.event.status === "completed",
          "Native terminal is missing, duplicated or failed",
        );
        const finals = parsed.filter(
          (row) =>
            row.item.kind === "provider" &&
            row.item.event.type === "message.updated" &&
            row.item.event.message?.role === "assistant" &&
            row.item.event.message?.streaming === false,
        );
        assert(
          finals.length === 1 && finals[0]!.item.event.message.text === input.expectedFinalText,
          "The public final assistant message differs from the frozen model result",
        );
        assert(
          finals[0]!.sequence < terminals[0]!.sequence,
          "Native terminal preceded the final message",
        );
        const journal = await owner.runStoreSnapshot();
        const entry = journal.snapshot.requests?.entries.find(
          (row) => row.request.requestId === `turn-${input.turn}`,
        );
        assert(
          entry?.status === "completed" && receipt.committed.status === "committed",
          "Native completion has no public committed checkpoint",
        );
        await owner.append("model-native-terminal-verified", {
          turn: input.turn,
          nativeSessionId: input.nativeSessionId,
          terminal: terminals[0],
          final: finals[0],
          receipt,
        });
        return { durable: true, terminalCount: 1 };
      },
      verifyPhysicalRecovery: async (input: {
        fromIncarnation: string;
        toIncarnation: string;
        nativeSessionId: string;
        checkpoint: unknown;
        receipt: ModelRecoveryEvidence;
      }) => {
        const verified = verifyModelPhysicalRecovery(
          {
            owner: owner.shardOwner(),
            runId: (await owner.config()).runId,
            processId: "official-codex",
            controllerClaim: control(this.#logicalReplacements + 1),
            nativeSessionId: this.#nativeSessionId!,
            checkpoint: owner.lifecycle.currentCheckpoint(),
            from: this.current(),
            to: { incarnation: input.toIncarnation, loaderId: input.receipt.candidate.loaderId },
          },
          input.receipt,
        );
        assert(
          input.fromIncarnation === verified.from.incarnation &&
            input.nativeSessionId === verified.nativeSessionId &&
            equals(input.checkpoint, verified.checkpoint),
          "Model recovery verifier received another logical owner",
        );
        return { durable: true, retirementCompleted: true, ...verified };
      },
      verifyReplacement: async (input: {
        fromIncarnation: string;
        toIncarnation: string;
        nativeSessionId: string;
        receipt: { sequence: number };
        modelSocketDrain: unknown;
      }) => {
        const release = await owner.writerReleaseFor(input.fromIncarnation);
        assert(
          release.sequence === input.receipt.sequence &&
            this.#nativeSessionId === input.nativeSessionId,
          "Replacement stop receipt changed",
        );
        assert(
          input.toIncarnation !== input.fromIncarnation,
          "Replacement reused its native host identity",
        );
        await owner.append("model-prepublication-stop-verified", { ...input, release });
        return { durable: true, stopConfirmed: true, joinConfirmed: true, oldWriterFenced: true };
      },
    });
  }
  async prepare(input: Incarnation) {
    await this.owner.assertLiveOwner();
    assert(!this.#preparing, "A model incarnation transition is already in progress");
    this.#preparing = true;
    try {
      if (!input.restored) {
        assert(!this.#initial && !this.#current, "Initial process preparation was repeated");
        this.#initial = input;
        this.peer.prepareIncarnation(input.incarnation);
      } else {
        assert(
          this.#initial && this.#current && this.#nativeSessionId,
          "Restored model preparation has no logical native owner",
        );
        const recovery = await this.owner.physicalRecoveryFor(input);
        if (recovery) {
          const verified = await this.peer.recoverIncarnation({
            fromIncarnation: this.#current.incarnation,
            toIncarnation: input.incarnation,
            nativeSessionId: this.#nativeSessionId,
            checkpoint: this.owner.lifecycle.currentCheckpoint(),
            receipt: recovery,
          });
          await this.owner.append("model-physical-recovery-verified", {
            input,
            verified,
            evidence: recovery,
          });
        } else {
          assert(
            this.#logicalReplacements === 0 && this.owner.modelTransition() === "replace",
            "A second logical replacement or unproved physical recovery is forbidden",
          );
          assert(input.loaderId !== this.#current.loaderId, "Replacement reused the old loader");
          const release = await this.owner.writerReleaseFor(this.#current.incarnation);
          await this.peer.recordReplacement({
            afterCompletedTurn: 1,
            fromIncarnation: this.#current.incarnation,
            toIncarnation: input.incarnation,
            nativeSessionId: this.#nativeSessionId,
            receipt: release,
          });
          this.peer.prepareIncarnation(input.incarnation);
          this.#logicalReplacements++;
        }
      }
      this.#current = input;
      return await this.owner.append("model-incarnation-prepared", {
        ...input,
        logicalIncarnation: this.#logicalReplacements,
      });
    } finally {
      this.#preparing = false;
    }
  }
  logicalIncarnation() {
    return this.#logicalReplacements;
  }
  bind(nativeSessionId: string) {
    this.peer.bindNativeSession(nativeSessionId);
    this.#nativeSessionId = nativeSessionId;
  }
  begin(turn: number) {
    assert(this.#current, "The actual process has not prepared its model transport");
    const expected = EXPECTATIONS.turns[turn - 1];
    assert(expected, "Unexpected qualifier turn");
    return this.peer.beginTurn({
      turn,
      incarnation: this.#current.incarnation,
      prompt: expected.prompt,
    });
  }
  async complete(turn: number) {
    const receipt = await this.owner.knownTurn(turn);
    await this.peer.completeNativeTurn({ turn, receipt });
    await this.owner.artifact(`model-snapshot-turn-${turn}`, jsonBytes(this.peer.snapshot()));
  }
  async fetch(request: Request) {
    await this.owner.assertLiveOwner();
    return await this.peer.fetch(request);
  }
  async finish() {
    let complete;
    let closed;
    try {
      complete = this.peer.assertComplete();
    } finally {
      closed = await this.peer.closeAndJoin();
    }
    const ref = await this.owner.artifact("model-final-snapshot", jsonBytes(this.peer.snapshot()));
    return { complete, closed, snapshot: ref };
  }
  current() {
    assert(this.#current, "No actual model incarnation");
    return this.#current;
  }
}
