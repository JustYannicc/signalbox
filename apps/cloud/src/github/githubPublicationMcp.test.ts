import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { handleMcpRequest } from "../api/mcpRoutes.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import { signLocalKey } from "../localKeys/LocalKeys.ts";
import { layerConfig } from "../testing.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import { publicationFixture, USER } from "./githubPublicationTesting.ts";

const Answer = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.String })),
  isError: Schema.optional(Schema.Boolean),
});
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(Answer));
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const bodyOf = (text: string) =>
  text.trimStart().startsWith("{")
    ? text
    : (text
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5) ?? "{}");

describe("cloud publication MCP", () => {
  it.effect("publishes through the authenticated signalbox_call tool and safely repeats", () =>
    Effect.gen(function* () {
      const f = yield* publicationFixture();
      const user = f.cloud.userDirectory.forUser(USER);
      const created = yield* user.createLocalKey("Publication agent", {
        scopes: ["orchestration:read", "orchestration:operate", "source-control:write"],
        model: false,
      });
      if (created._tag !== "created") throw new Error("Expected a personal key");
      const layer = Layer.mergeAll(
        CloudTokens.layer.pipe(Layer.provide(layerConfig())),
        Layer.succeed(UserDirectory, f.cloud.userDirectory),
      );
      const key = yield* signLocalKey(USER, created.secret).pipe(Effect.provide(layer));
      let session: string | null = null;
      let id = 0;
      const rpc = (method: string, params: object) =>
        handleMcpRequest(
          new Request("https://cloud.test/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...(session === null
                ? {}
                : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          }),
        ).pipe(
          Effect.provide(layer),
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              expect(response.status).toBe(200);
              session = response.headers.get("mcp-session-id") ?? session;
              const text = yield* Effect.promise(() => response.text());
              return yield* decodeAnswer(bodyOf(text));
            }),
          ),
        );
      yield* rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "publication-test", version: "1" },
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = yield* rpc("tools/call", {
          name: "signalbox_call",
          arguments: { operation: "sourceControl.publishRepository", input: f.input },
        });
        expect(answer.error).toBeUndefined();
        const result = yield* decodeToolResult(answer.result);
        expect(result.isError ?? false).toBe(false);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({
          status: "pushed",
          repository: { nameWithOwner: f.input.repository },
        });
      }
      expect(f.github.head("main")).toBe(f.main);
      expect(f.git(["rev-list", "--count", "main"]).toString().trim()).toBe("2");
      expect(f.creations).toHaveLength(1);
      expect(f.receiveCalls()).toHaveLength(1);
    }),
  );
});
