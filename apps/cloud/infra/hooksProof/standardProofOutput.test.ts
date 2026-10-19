import { makeSecretScrubber } from "@signalbox/runner-protocol/SecretScrubber";
import { describe, expect, it } from "vite-plus/test";
import { createStandardProofOutput } from "./standardProofOutput.ts";

const secret = { name: "TOKEN", value: "raw-output-秘密-value" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunks(parts: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

describe("standard proof command output", () => {
  it("captures the actual bounded native output before scrubbing split UTF-8 bytes", async () => {
    const boundary = createStandardProofOutput(() => makeSecretScrubber([secret]));
    const command = {
      executable: "/bin/bash",
      argv: ["/bin/bash", "-c", "cat /work/official-write.txt"],
    };
    const raw = encoder.encode(`native ${secret.value}\n`);
    const output = boundary.stdout(
      command,
      chunks([raw.subarray(0, 13), raw.subarray(13, 17), raw.subarray(17)]),
    );
    expect(boundary.takeFileRead("/work/official-write.txt")).toBeUndefined();
    expect(await new Response(output).text()).toBe("native {{secret:TOKEN}}\n");
    const proof = boundary.takeFileRead("/work/official-write.txt");
    expect(proof).toMatchObject(command);
    expect(decoder.decode(proof!.stdout)).toBe(`native ${secret.value}\n`);
    expect(boundary.takeFileRead("/work/official-write.txt")).toBeUndefined();
    const stderr = boundary.stderr(chunks([encoder.encode(secret.value)]));
    expect(await new Response(stderr).text()).toBe("{{secret:TOKEN}}");
  });

  it("does not publish a completed capture when the output exceeds the fixture bound", async () => {
    const boundary = createStandardProofOutput(() => makeSecretScrubber([secret]));
    const output = boundary.stdout(
      { executable: "/bin/bash", argv: ["bash", "-c", "cat /workspace/proof.txt"] },
      chunks([new Uint8Array(1_048_577)]),
    );
    await expect(new Response(output).text()).rejects.toThrow("Proof output exceeded its bound");
    expect(boundary.takeFileRead("/workspace/proof.txt")).toBeUndefined();
  });

  it("retains only the last native read for each proof path", async () => {
    const boundary = createStandardProofOutput(() => makeSecretScrubber([secret]));
    const command = {
      executable: "/bin/bash",
      argv: ["bash", "-c", "cat /work/official-write.txt"],
    };
    await new Response(boundary.stdout(command, chunks([encoder.encode("first")]))).text();
    await new Response(boundary.stdout(command, chunks([encoder.encode("last")]))).text();
    expect(decoder.decode(boundary.takeFileRead("/work/official-write.txt")!.stdout)).toBe("last");
    expect(boundary.takeFileRead("/work/official-write.txt")).toBeUndefined();
    await new Response(boundary.stdout(command, chunks([encoder.encode("unconsumed")]))).text();
    boundary.close();
    expect(boundary.takeFileRead("/work/official-write.txt")).toBeUndefined();
  });
});
