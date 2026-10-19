import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(context, environment) {
      this.ctx = context;
      this.env = environment;
    }

    fetch() {
      return new Response("unused test base");
    }
  },
}));

import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
} from "../hooksProof/standardProofAdapter.ts";
import { createStandardProofModelGateway } from "../hooksProof/standardProofModelGateway.ts";
import { createStandardProofState } from "../hooksProof/standardProofState.ts";
import { configureProofModelHttp } from "./ProofFacet.mjs";

describe("Codex proof HTTP model selection", () => {
  it("keeps the composed OpenAI gateway when a model observer returns undefined", async () => {
    const database = createProofTestStorage();
    const state = createStandardProofState(database.storage, "codex-model-observer");
    const proofSecrets = [STANDARD_PROOF_NAMED_SECRET, STANDARD_PROOF_VAULT_SECRET];
    let forwardedBody;
    try {
      const gateway = await createStandardProofModelGateway({
        authority: state.authority,
        assertActive: state.assertActive,
        registered: () => proofSecrets,
        completeResponse: { progress: "The proof completed", nextStep: "Review the result" },
        async forward(request) {
          forwardedBody = await request.json();
          return new Response(
            'event: response.completed\n\ndata: {"type":"response.completed"}\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const model = {
        baseUrl: "http://localhost/v1",
        supportsWebSockets: true,
        maxRetries: 3,
      };
      const modelHttp = (request) => gateway.serve(request, new AbortController().signal, "openai");
      const handleRequest = configureProofModelHttp(model, undefined, modelHttp);

      expect(model).toEqual({
        baseUrl: "http://mock.invalid/v1",
        supportsWebSockets: false,
        maxRetries: 0,
      });
      const raw = `${STANDARD_PROOF_NAMED_SECRET.value} ${STANDARD_PROOF_VAULT_SECRET.value}`;
      const response = await handleRequest(
        new Request("http://mock.invalid/v1/responses?stream=true", {
          method: "POST",
          headers: {
            authorization: "Bearer mock-only-codex-key",
            "content-type": "application/json",
            "openai-beta": "responses=experimental",
          },
          body: JSON.stringify({
            model: "codex-proof-model",
            input: [{ role: "user", content: `Use this context: ${raw}` }],
            stream: true,
          }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.completed");
      const proof = gateway.inspect();
      expect(proof).toMatchObject({ nativeForwardCount: 1, ok: true });
      expect(proof.nativeForwards[0]).toMatchObject({
        path: "/v1/responses?stream=true",
        provider: "openai",
        model: "codex-proof-model",
        responseStatus: 200,
        scrubbed: true,
      });
      const forwarded = JSON.stringify(forwardedBody);
      expect(forwarded).not.toContain(raw);
      expect(forwarded).toContain("{{secret:API_TOKEN}}");
      expect(forwarded).toContain("{{secret:VAULT_TOKEN}}");
    } finally {
      state.close();
      database.close();
    }
  });

  it("does not rewrite an explicitly returned custom model", () => {
    const customModel = {
      baseUrl: "ws://model.invalid",
      supportsWebSockets: true,
      http: () => new Response("custom model"),
    };
    const gateway = () => new Response("composed HTTP model");

    expect(configureProofModelHttp(customModel, customModel, gateway)).toBe(gateway);
    expect(customModel).toEqual({
      baseUrl: "ws://model.invalid",
      supportsWebSockets: true,
      http: expect.any(Function),
    });
  });
});
