import { describe, expect, it } from "vite-plus/test";
import { observeCodexReady } from "../CodexTransport.ts";

const encoder = new TextEncoder();

async function observe(params: unknown, standardFormInput: boolean) {
  const frame = encoder.encode(JSON.stringify({ method: "signalbox/ready", params }) + "\n");
  const source = new ReadableStream<Uint8Array>({
    start(output) {
      output.enqueue(frame.subarray(0, 13));
      output.enqueue(frame.subarray(13));
      output.close();
    },
  });
  const observed = observeCodexReady(source, { standard_form_input: standardFormInput });
  const outcomes = await Promise.allSettled([
    observed.ready,
    new Response(observed.stdout).arrayBuffer(),
  ]);
  return { frame, outcomes };
}

describe("Codex host capability readiness", () => {
  it("accepts the old ready contract when the host requests no standard form input", async () => {
    const { frame, outcomes } = await observe({ upstreamVersion: "0.162.1" }, false);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: frame.buffer });
  });

  it("accepts an explicit negotiated capability and preserves all native output bytes", async () => {
    const { frame, outcomes } = await observe(
      { host_capabilities: { standard_form_input: true } },
      true,
    );
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: frame.buffer });
  });

  it.each([
    {},
    { host_capabilities: {} },
    { host_capabilities: { standard_form_input: false } },
    { host_capabilities: { standard_form_input: "true" } },
  ])("rejects unsupported standard form negotiation: %j", async (params) => {
    const { outcomes } = await observe(params, true);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({
          message: "Codex did not negotiate the requested standard form input capability",
        });
    }
  });
});
