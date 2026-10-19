import { describe, expect, it } from "vite-plus/test";
import { secretForms } from "@signalbox/runner-protocol/SecretScrubber";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
  STANDARD_PROOF_WRITE,
  scrubStandardProofRecord,
} from "./standardProofAdapter.ts";
import {
  captureStandardProofSessions,
  inspectStandardProofSessions,
} from "./standardProofRecords.ts";

describe("persisted official session evidence", () => {
  it("rejects prior-isolate fixture values in every scrubbed form without exporting them", () => {
    const database = createProofTestStorage();
    const host = createProofFilesystemHost(database.storage);
    const root = "/home/codex/sessions";
    const oldValues = [
      "api-deadbeef-東京",
      "proof-vault-12345678-1234-4abc-9def-123456789abc-秘密",
      ...Array.from({ length: 16 }, (_, offset) => {
        const hex = [..."0123456789abcdef"];
        const mixed = Array.from({ length: 32 }, (_, at) => hex[(at + offset) % 16]).join("");
        const uuid = `${mixed.slice(0, 8)}-${mixed.slice(8, 12)}-4${mixed.slice(13, 16)}-a${mixed.slice(17, 20)}-${mixed.slice(20)}`;
        return [`api-${mixed.slice(0, 8)}-東京`, `proof-vault-${uuid}-秘密`];
      }).flat(),
    ];
    try {
      host.fs.fs.mkdirSync(root, { recursive: true });
      const baseline = captureStandardProofSessions(host.filesystem, root);
      host.fs.fs.writeFileSync(
        `${root}/current.jsonl`,
        JSON.stringify({ text: STANDARD_PROOF_WRITE }),
      );
      for (const value of oldValues) {
        expect(value).not.toBe(STANDARD_PROOF_NAMED_SECRET.value);
        expect(value).not.toBe(STANDARD_PROOF_VAULT_SECRET.value);
        for (const form of secretForms(value)) {
          host.fs.fs.writeFileSync(`${root}/prior.jsonl`, form);
          expect(inspectStandardProofSessions(host.filesystem, root, baseline)).toMatchObject({
            ok: false,
            unexpectedRawSecret: true,
          });
          const record = scrubStandardProofRecord({ ok: true, diagnostic: form });
          expect(record).toMatchObject({
            ok: false,
            recordBoundary: { unexpectedRawSecret: true },
          });
          expect(JSON.stringify(record)).not.toContain(form);
          const keyRecord = scrubStandardProofRecord({ ok: true, diagnostic: { [form]: "value" } });
          expect(keyRecord).toMatchObject({
            ok: false,
            recordBoundary: { unexpectedRawSecret: true },
          });
          expect(JSON.stringify(keyRecord)).not.toContain(form);
        }
      }
    } finally {
      host.filesystem.dispose();
      host.persistence.dispose();
      host.wakes.dispose();
      database.close();
    }
  });

  it("requires real session bytes and refuses a raw secret in any nested session", () => {
    const database = createProofTestStorage();
    const host = createProofFilesystemHost(database.storage);
    const root = "/home/claude/.claude/projects";
    try {
      const baseline = captureStandardProofSessions(host.filesystem, root);
      expect(inspectStandardProofSessions(host.filesystem, root, baseline).ok).toBe(false);
      host.fs.fs.mkdirSync(`${root}/work/subagents`, { recursive: true });
      host.fs.fs.writeFileSync(
        `${root}/work/session.jsonl`,
        JSON.stringify({ text: STANDARD_PROOF_WRITE }),
      );
      expect(inspectStandardProofSessions(host.filesystem, root, baseline)).toMatchObject({
        ok: true,
        files: 1,
        placeholderNames: ["API_TOKEN", "VAULT_TOKEN"],
        unexpectedRawSecret: false,
      });
      const nextTurn = captureStandardProofSessions(host.filesystem, root);
      expect(inspectStandardProofSessions(host.filesystem, root, nextTurn)).toMatchObject({
        ok: false,
        newBytes: 0,
        placeholderNames: [],
      });
      host.fs.fs.appendFileSync(
        `${root}/work/session.jsonl`,
        "\n" + JSON.stringify({ text: "second turn without placeholders" }),
      );
      expect(inspectStandardProofSessions(host.filesystem, root, nextTurn).ok).toBe(false);
      host.fs.fs.appendFileSync(
        `${root}/work/session.jsonl`,
        "\n" + JSON.stringify({ text: STANDARD_PROOF_WRITE }),
      );
      expect(inspectStandardProofSessions(host.filesystem, root, nextTurn).ok).toBe(true);
      host.fs.fs.writeFileSync(
        `${root}/work/subagents/child.jsonl`,
        JSON.stringify({ text: STANDARD_PROOF_NAMED_SECRET.value }),
      );
      const rejected = inspectStandardProofSessions(host.filesystem, root, baseline);
      expect(rejected).toMatchObject({ ok: false, files: 2, unexpectedRawSecret: true });
      expect(JSON.stringify(rejected)).not.toContain(STANDARD_PROOF_NAMED_SECRET.value);
      expect(JSON.stringify(rejected)).not.toContain(STANDARD_PROOF_VAULT_SECRET.value);
      const rawInOldSession = captureStandardProofSessions(host.filesystem, root);
      host.fs.fs.appendFileSync(
        `${root}/work/session.jsonl`,
        "\n" + JSON.stringify({ text: STANDARD_PROOF_WRITE }),
      );
      expect(inspectStandardProofSessions(host.filesystem, root, rawInOldSession)).toMatchObject({
        ok: false,
        unexpectedRawSecret: true,
        placeholderNames: ["API_TOKEN", "VAULT_TOKEN"],
      });
    } finally {
      host.filesystem.dispose();
      host.persistence.dispose();
      host.wakes.dispose();
      database.close();
    }
  });
});
