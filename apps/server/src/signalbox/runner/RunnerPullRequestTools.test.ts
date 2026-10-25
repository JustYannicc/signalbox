import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENT_PULL_REQUEST_TOOL,
  PR_IMAGE_LIMIT,
  type Request,
} from "@signalbox/runner-protocol/PullRequestTools";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { serve, TOKEN } from "./RunnerAutomationTools.testkit.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("pull request tools on a cloud thread's machine", () => {
  it.effect("registers separate read and external-write tools on the real MCP server", () =>
    Effect.gen(function* () {
      const { mcp } = yield* serve();
      const listed = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        inputSchema: { properties?: Record<string, unknown> };
        annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
      }>;
      const tools = new Map(listed.map((tool) => [tool.name, tool]));

      expect([...tools.keys()]).toEqual(
        expect.arrayContaining([
          "read_pr",
          "edit_pr",
          "comment_pr",
          "reply_to_pr_review",
          "upload_pr_image",
        ]),
      );
      expect(tools.get("read_pr")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      for (const name of ["edit_pr", "comment_pr", "reply_to_pr_review", "upload_pr_image"]) {
        expect(tools.get(name)?.annotations, name).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        });
      }
      expect(tools.get("upload_pr_image")?.inputSchema.properties).toHaveProperty("path");
      expect(tools.get("upload_pr_image")?.inputSchema.properties).not.toHaveProperty("base64");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("forwards read and write actions through the thread drive token", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* serve();
      cloud.answers.push(503, { _tag: "ok", result: { number: 12, title: "Fix" } });
      const read = yield* call("read_pr", { number: 12 });
      expect(JSON.parse(read.content[0]!.text)).toEqual({ number: 12, title: "Fix" });
      expect(cloud.requests).toHaveLength(2);
      expect(cloud.requests[0]).toMatchObject({
        name: AGENT_PULL_REQUEST_TOOL,
        input: { _tag: "read", number: 12 },
        bearer: `Bearer ${TOKEN}`,
      });

      cloud.answers.push(
        { _tag: "ok", result: { updated: true } },
        { _tag: "ok", result: { commentId: 5 } },
        { _tag: "ok", result: { commentId: 8 } },
      );
      yield* call("edit_pr", { body: "Updated body" });
      yield* call("comment_pr", { body: "Thanks", operationId: "comment-1" });
      yield* call("reply_to_pr_review", {
        body: "Fixed",
        commentId: 7,
        operationId: "reply-1",
      });

      expect(cloud.requests.slice(2).map(({ name, input }) => ({ name, input }))).toEqual([
        {
          name: AGENT_PULL_REQUEST_TOOL,
          input: { _tag: "edit", body: "Updated body" },
        },
        {
          name: AGENT_PULL_REQUEST_TOOL,
          input: { _tag: "comment", body: "Thanks", operationId: "comment-1" },
        },
        {
          name: AGENT_PULL_REQUEST_TOOL,
          input: { _tag: "reply", body: "Fixed", commentId: 7, operationId: "reply-1" },
        },
      ]);
      expect(cloud.requests.every((request) => request.bearer === `Bearer ${TOKEN}`)).toBe(true);
      expect(JSON.stringify(cloud.requests)).not.toContain("github-token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads bounded local images, sniffs their bytes, and sanitizes their names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const file = path.join(directory, "Before capture @ review.PNG");
      yield* fs.writeFile(file, PNG);
      const { call, cloud } = yield* serve();

      const uploaded = yield* call("upload_pr_image", { path: file, operationId: "image-1" });
      expect(uploaded.isError).toBeUndefined();
      expect(cloud.requests).toHaveLength(1);
      expect(cloud.requests[0]).toMatchObject({
        name: AGENT_PULL_REQUEST_TOOL,
        bearer: `Bearer ${TOKEN}`,
      });
      const request = cloud.requests[0]!.input as Request;
      expect(request._tag).toBe("image");
      if (request._tag === "image") {
        expect(request.name).toBe("Before_capture___review.png");
        expect(request.mimeType).toBe("image/png");
        expect(request.operationId).toBe("image-1");
        expect(Buffer.from(request.base64, "base64")).toEqual(Buffer.from(PNG));
      }

      const unsupported = path.join(directory, "secret.txt");
      yield* fs.writeFileString(unsupported, "not an image");
      const rejected = yield* call("upload_pr_image", {
        path: unsupported,
        operationId: "image-2",
      });
      expect(rejected.isError).toBe(true);
      expect(cloud.requests).toHaveLength(1);

      const oversized = path.join(directory, "too-large.png");
      yield* fs.writeFile(oversized, new Uint8Array(PR_IMAGE_LIMIT + 1));
      const tooLarge = yield* call("upload_pr_image", {
        path: oversized,
        operationId: "image-3",
      });
      expect(tooLarge.isError).toBe(true);
      expect(cloud.requests).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
