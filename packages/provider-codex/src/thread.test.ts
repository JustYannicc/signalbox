import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { providerSession } from "./thread.ts";

describe("Codex portable session cwd", () => {
  it("uses the host directory for a null cwd without reading the native process", () => {
    const nativeCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("Native process is unavailable");
    });
    let session;
    try {
      session = providerSession({
        providerSessionId: ProviderSessionId.make("session"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        cwd: null,
        defaultCwd: "/facet/work",
        model: "model",
        now: DateTime.makeUnsafe(0),
      });
    } finally {
      nativeCwd.mockRestore();
    }
    expect(session.cwd).toBe("/facet/work");
  });
  it("preserves an explicit session directory", () => {
    const session = providerSession({
      providerSessionId: ProviderSessionId.make("session"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      cwd: "/facet/project",
      defaultCwd: "/facet/work",
      model: "model",
      now: DateTime.makeUnsafe(0),
    });
    expect(session.cwd).toBe("/facet/project");
  });
});
