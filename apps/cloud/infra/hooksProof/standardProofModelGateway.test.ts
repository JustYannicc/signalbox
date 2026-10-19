import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadHarnessActiveAttempt } from "../../src/hooks/ThreadHarnessHooks.ts";
import { createMockMessagesApi } from "../claudeTurnProof/mockMessages.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
} from "./standardProofAdapter.ts";
import {
  createStandardProofModelGateway,
  STANDARD_PROOF_MODEL_ID,
  STANDARD_PROOF_MODEL_POOL_ID,
} from "./standardProofModelGateway.ts";
import { createStandardProofState } from "./standardProofState.ts";

const NOTE = { nextStep: "Check the saved result", progress: "The tool turn finished" };
const attemptKey = (active: ThreadHarnessActiveAttempt) =>
  `${active.threadId}/${active.runId}/${active.attemptId}/${active.generation}`;

describe("standard proof ModelAccess adapter", () => {
  it.each(["cancel", "replace"] as const)(
    "does not forward when the attempt changes during a body read: %s",
    async (change) => {
      const database = createProofTestStorage();
      const state = createStandardProofState(database.storage, "body-read-race");
      const controller = new AbortController();
      let forwarded = 0;
      try {
        const gateway = await createStandardProofModelGateway({
          authority: state.authority,
          assertActive: state.assertActive,
          registered: () => [],
          completeResponse: NOTE,
          async forward() {
            forwarded += 1;
            return Response.json({ ok: true });
          },
        });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const request = new Request("http://proof.invalid/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "native-proof-model", messages: [] }),
        });
        const clone = request.clone.bind(request);
        let reads = 0;
        Object.defineProperty(request, "clone", {
          value: () => {
            const copy = clone();
            // The forward-side model read follows the native request's body and model reads.
            if (++reads === 3) {
              const json = copy.json.bind(copy);
              copy.json = async () => {
                entered.resolve();
                await release.promise;
                return json();
              };
            }
            return copy;
          },
        });
        const result = gateway.serve(request, controller.signal).then(
          () => null,
          (error: unknown) => error,
        );
        await entered.promise;
        if (change === "cancel") controller.abort(new Error("cancelled during body read"));
        else createStandardProofState(database.storage, "body-read-race").close();
        release.resolve();
        expect(await result).toBeInstanceOf(Error);
        expect(forwarded).toBe(0);
        expect(gateway.inspect().nativeForwardCount).toBe(0);
      } finally {
        state.close();
        database.close();
      }
    },
  );

  it("denies before registration, scrubs the status request, and forwards Claude through ModelAccess", async () => {
    const database = createProofTestStorage();
    const state = createStandardProofState(database.storage, "model-gateway");
    const mock = createMockMessagesApi({ recordRequestBodies: true, finalText: "Claude finished" });
    let registered: ReadonlyArray<SecretValue> | null = null;
    const proofSecrets: ReadonlyArray<SecretValue> = [
      STANDARD_PROOF_NAMED_SECRET,
      STANDARD_PROOF_VAULT_SECRET,
    ];
    try {
      const gateway = await createStandardProofModelGateway({
        authority: state.authority,
        assertActive: state.assertActive,
        registered: () => registered,
        completeResponse: NOTE,
        forward: (request) => mock.fetch(request),
      });
      expect(gateway.inspect()).toMatchObject({
        unregisteredProbe: { attempted: true, denied: true, forwardedCalls: 0 },
        statusForwardCount: 0,
        nativeForwardCount: 0,
        ok: true,
      });

      registered = proofSecrets;
      const active = state.authority.activeAttempt();
      if (!active) throw new Error("Missing proof attempt");
      const signal = new AbortController().signal;
      expect(
        await gateway.complete(
          {
            poolId: STANDARD_PROOF_MODEL_POOL_ID,
            model: STANDARD_PROOF_MODEL_ID,
            attempt: attemptKey(active),
          },
          signal,
        ),
      ).toEqual(NOTE);

      const nativeRaw = `${STANDARD_PROOF_NAMED_SECRET.value} ${STANDARD_PROOF_VAULT_SECRET.value}`;
      const response = await gateway.serve(
        new Request("http://mock.anthropic.invalid/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "mock-only-dummy-key" },
          body: JSON.stringify({
            model: "claude-proof-model",
            max_tokens: 24,
            stream: false,
            messages: [{ role: "user", content: `Use this context: ${nativeRaw}` }],
          }),
        }),
        signal,
      );
      expect(response.status).toBe(200);
      await response.json();
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]).toMatchObject({
        url: "http://mock.anthropic.invalid/v1/messages",
        method: "POST",
      });

      const proof = gateway.inspect();
      expect(proof).toMatchObject({
        kind: "real-model-access-with-test-authority-and-test-pool-adapter",
        modelAccess: "makeModelAccess + Effect.runPromise",
        authority: "TEST AUTHORITY",
        poolAdapter: "TEST POOL ADAPTER",
        authorizationCount: 3,
        statusForwardCount: 1,
        nativeForwardCount: 1,
        ok: true,
      });
      expect(proof.statusForwards[0]).toMatchObject({
        pool: { poolId: STANDARD_PROOF_MODEL_POOL_ID },
        path: "/v1/messages",
        thread: String(active.threadId),
        runId: String(active.runId),
        method: "POST",
        model: STANDARD_PROOF_MODEL_ID,
        responseStatus: 200,
      });
      expect(proof.nativeForwards[0]).toMatchObject({
        pool: { poolId: STANDARD_PROOF_MODEL_POOL_ID },
        path: "/v1/messages",
        thread: String(active.threadId),
        runId: String(active.runId),
        method: "POST",
        model: "claude-proof-model",
        responseStatus: 200,
      });
      for (const secret of proofSecrets) {
        expect(proof.statusForwards[0]?.body).toContain(secretPlaceholder(secret.name));
        expect(proof.nativeForwards[0]?.body).toContain(secretPlaceholder(secret.name));
        expect(JSON.stringify(mock.requests[0]?.body)).toContain(secretPlaceholder(secret.name));
        expect(JSON.stringify(proof)).not.toContain(secret.value);
      }
      expect(proof.statusForwards[0]?.body).not.toContain(nativeRaw);
      expect(proof.nativeForwards[0]?.body).not.toContain(nativeRaw);
    } finally {
      state.close();
      database.close();
    }
  });
});
