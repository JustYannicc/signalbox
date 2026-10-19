import {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import type { SeedStage } from "./contracts.ts";
import type { SeedCatalog } from "./seed.ts";
import { verifySeedFiles, writeSeedFiles } from "./seed.ts";
import type { HostStorage } from "./storage.ts";

const openCodec = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      bootAttemptId: Schema.String,
      session: Schema.Struct({
        threadId: ThreadId,
        providerSessionId: ProviderSessionId,
        modelSelection: ModelSelection,
        runtimePolicy: ProviderAdapterV2RuntimePolicy,
        resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
        initialNativeThreadId: Schema.optionalKey(Schema.String),
        initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
      }),
      checkpoint: Schema.optionalKey(
        Schema.Struct({
          release: Schema.Struct({
            harness: Schema.Literals(["claude-code", "codex"]),
            version: Schema.String,
            manifestSha256: Schema.String,
            modules: Schema.Record(
              Schema.String,
              Schema.Struct({ bytes: Schema.Number, sha256: Schema.String }),
            ),
          }),
          providerSession: OrchestrationV2ProviderSession,
          snapshot: Schema.Struct({
            providerThread: OrchestrationV2ProviderThread,
            providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
            messages: Schema.Array(OrchestrationV2ConversationMessage),
            runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
            providerPayload: Schema.optional(Schema.Unknown),
          }),
          revision: Schema.Struct({ commit: Schema.String }),
        }),
      ),
    }),
  ),
);
const encodeOpen = Schema.encodeSync(openCodec);
const decodeOpen = Schema.decodeSync(openCodec);
export const snapshotOpen = (input: Parameters<typeof encodeOpen>[0]) =>
  decodeOpen(encodeOpen(input));

export function createBootState(storage: HostStorage, catalog: SeedCatalog, threadId: string) {
  let poisoned = false;
  let admitted = false;
  const check = () => {
    if (poisoned) throw new Error("Seed transaction failed; reconstruct the host");
  };
  const receipt = (stage: SeedStage) =>
    [
      ...storage.database.sql.exec(
        "SELECT catalog_id FROM harness_seed_receipts WHERE stage=?",
        stage,
      ),
    ][0];
  const requireReceipt = (stage: SeedStage) => {
    if (receipt(stage)?.catalog_id !== catalog.id)
      throw new Error("Seed receipt is missing or changed");
  };
  return {
    check,
    async seed(stage: SeedStage, signal: AbortSignal) {
      check();
      if (admitted || (stage !== "assets" && stage !== "programs"))
        throw new Error("Invalid seed order");
      const payloads = await catalog.payloads(stage, signal);
      check();
      signal.throwIfAborted();
      try {
        storage.database.transactionSync(() => {
          check();
          if (stage === "programs") requireReceipt("assets");
          if (receipt(stage) !== undefined) {
            requireReceipt(stage);
            verifySeedFiles(storage.files, catalog.stages[stage], payloads);
          } else {
            writeSeedFiles(storage.files, catalog.stages[stage], payloads);
            storage.database.sql.exec(
              "INSERT INTO harness_seed_receipts (stage,catalog_id) VALUES (?,?)",
              stage,
              catalog.id,
            );
          }
        });
      } catch (error) {
        poisoned = true;
        throw error;
      }
    },
    async claim(attemptId: string, inputHash: string, signal: AbortSignal) {
      check();
      if (!attemptId) throw new Error("Boot attempt identity is required");
      const assets = await catalog.payloads("assets", signal);
      const programs = await catalog.payloads("programs", signal);
      check();
      signal.throwIfAborted();
      storage.database.transactionSync(() => {
        requireReceipt("assets");
        requireReceipt("programs");
        verifySeedFiles(storage.files, catalog.stages.assets, assets);
        verifySeedFiles(storage.files, catalog.stages.programs, programs);
        storage.database.sql.exec(
          "INSERT INTO harness_boot_attempts (thread_id,attempt_id,catalog_id,input_hash) VALUES (?,?,?,?)",
          threadId,
          attemptId,
          catalog.id,
          inputHash,
        );
      });
      admitted = true;
    },
  };
}
