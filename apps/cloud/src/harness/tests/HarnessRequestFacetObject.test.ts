import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { durableRootContext } from "./processIncarnation/durableRootFixture.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: unknown;
    readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

it("preserves all failure reasons before the fresh-process Promise boundary", async () => {
  const root = durableRootContext("fresh-failure");
  const original = Object.assign(new Error("Native MCP binding failed"), { code: "MCP_BINDING" });
  const cleanup = Object.assign(new Error("Native cleanup failed"), { code: "NATIVE_CLEANUP" });
  const Class = createHarnessRequestFacetClass(() =>
    Effect.failCause(
      Cause.combine(
        Cause.fail(
          new HarnessRequestFacetError("Fresh process composition failed.", { cause: original }),
        ),
        Cause.die(cleanup),
      ),
    ),
  );
  const facet = new Class(root.context as unknown as DurableObjectState, {});
  try {
    const failure = await facet
      .startFresh({
        operationId: "create",
        targetFacetNonce: facet.facetNonce,
        publisherKey: "publisher-key",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessRequestFacetError);
    if (!(failure instanceof HarnessRequestFacetError))
      throw new Error("Missing typed RPC failure");
    expect(failure.message).toBe("Harness fresh process creation failed.");
    expect(JSON.parse(JSON.stringify(failure.cause))).toMatchObject([
      {
        _tag: "Fail",
        error: {
          message: "Fresh process composition failed.",
          cause: {
            name: "Error",
            message: "Native MCP binding failed",
            code: "MCP_BINDING",
            stack: original.stack,
          },
        },
      },
      {
        _tag: "Die",
        defect: {
          name: "Error",
          message: "Native cleanup failed",
          code: "NATIVE_CLEANUP",
          stack: cleanup.stack,
        },
      },
    ]);
  } finally {
    try {
      await facet.dispose(facet.facetNonce);
    } finally {
      root.close();
    }
  }
});

it.each(["throw", "reject"] as const)(
  "preserves a prepared-release reader failure that %ss",
  async (mode) => {
    const root = durableRootContext(`reader-${mode}`);
    const original = Object.assign(new Error("Prepared release observation failed"), {
      code: "RELEASE_READ",
    });
    const Class = createHarnessRequestFacetClass(({ facetNonce }) =>
      Effect.succeed({
        facetNonce,
        runId: "reader-failure",
        store: {
          execute: async () => {
            throw new Error("Unexpected store access");
          },
        },
        verify: () => Effect.void,
        open: () => Effect.fail(new HarnessRequestFacetError("Unexpected native open")),
        loadedPreparedRelease: () => {
          if (mode === "throw") throw original;
          return Promise.reject(original);
        },
      }),
    );
    const facet = new Class(root.context as unknown as DurableObjectState, {});
    try {
      const failure = await facet.loadedPreparedRelease().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(HarnessRequestFacetError);
      if (!(failure instanceof HarnessRequestFacetError))
        throw new Error("Missing typed RPC failure");
      expect(failure.cause).toMatchObject([
        {
          _tag: "Die",
          defect: { message: original.message, code: "RELEASE_READ", stack: original.stack },
        },
      ]);
    } finally {
      try {
        await facet.dispose(facet.facetNonce);
      } finally {
        root.close();
      }
    }
  },
);
