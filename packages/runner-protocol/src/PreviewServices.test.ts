import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { PreviewService } from "./PreviewServices.ts";
import {
  tunnelRunnerFrame,
  tunnelThreadFrame,
  type TunnelRunnerMessage,
  type TunnelThreadMessage,
} from "./PreviewTunnel.ts";

const decodePreviewService = Schema.decodeSync(PreviewService);

describe("PreviewService", () => {
  it("accepts an explicit command and drive-relative working directory", () => {
    expect(
      decodePreviewService({
        port: 5173,
        command: "pnpm dev --host 0.0.0.0",
        cwd: "apps/web",
      }),
    ).toEqual({ port: 5173, command: "pnpm dev --host 0.0.0.0", cwd: "apps/web" });
  });

  it("rejects invalid ports, blank commands, and working directories outside the drive", () => {
    for (const service of [
      { port: 0, command: "pnpm dev", cwd: "." },
      { port: 65536, command: "pnpm dev", cwd: "." },
      { port: 5173, command: "  ", cwd: "." },
      { port: 5173, command: "pnpm dev", cwd: "../other-drive" },
      { port: 5173, command: "pnpm dev", cwd: "/tmp" },
    ]) {
      expect(() => decodePreviewService(service)).toThrow();
    }
  });

  it("roundtrips persisted declarations and preview drive access through tunnel frames", () => {
    const service = { port: 5173, command: "pnpm dev", cwd: "apps/web" };
    const runnerMessage: TunnelRunnerMessage = { type: "services", services: [service] };
    const threadMessage: TunnelThreadMessage = {
      type: "welcome",
      services: [service],
      drive: { driveId: "drive-1", token: "drive-token", remoteToken: null },
    };
    const ack: TunnelThreadMessage = { type: "services.saved", services: [service] };

    expect(tunnelRunnerFrame.decode(tunnelRunnerFrame.encode(runnerMessage))).toEqual(
      runnerMessage,
    );
    expect(tunnelThreadFrame.decode(tunnelThreadFrame.encode(threadMessage))).toEqual(
      threadMessage,
    );
    expect(tunnelThreadFrame.decode(tunnelThreadFrame.encode(ack))).toEqual(ack);
  });
});
