import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createProductClaudeHarnessSessionHost } from "../ProductClaudeHarnessSessionHost.ts";
import { createProductCodexHarnessSessionHost } from "../ProductCodexHarnessSessionHost.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it.effect.each([
  {
    entry: "Claude",
    expected: "claude-code",
    harness: "codex",
    create: createProductClaudeHarnessSessionHost,
  },
  {
    entry: "Codex",
    expected: "codex",
    harness: "claude-code",
    create: createProductCodexHarnessSessionHost,
  },
])(
  "rejects $harness options at the $entry entry before acquisition",
  ({ entry, expected, harness, create }) =>
    Effect.gen(function* () {
      const acquire = vi.fn(() => {
        throw new Error("Resources must not be acquired");
      });
      const options = {
        native: { harness },
        get release() {
          return acquire();
        },
        get programs() {
          return acquire();
        },
        get files() {
          return acquire();
        },
      };
      // Untyped callers can bypass the entry's native option type.
      // @ts-expect-error Only the wrong harness discriminator should be needed for rejection.
      const rejected = create(options);
      const failure = yield* Effect.flip(rejected);
      expect(failure).toMatchObject({
        _tag: "HarnessError",
        operation: "open",
        message: `${entry} product host entry/harness mismatch: expected ${expected}.`,
      });
      expect(acquire).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
);
