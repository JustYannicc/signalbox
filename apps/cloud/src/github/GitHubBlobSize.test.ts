import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeGitHubApi } from "./GitHubApi.ts";

const token = "github-blob-size-canary";
const repository = "acme/source";
const oid = "fb742692f53041f2658d9e7e0ef54f93ba7d64f1";
const bodyWith = (object: unknown) => ({ data: { repository: { object } } });
const blob = (byteSize: number) => ({ __typename: "Blob", oid, byteSize });
const responseClient = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );

it.effect.each([0, 65536, 112468])("reads a %i-byte blob's size without its content", (size) => {
  const client = HttpClient.make((request) => {
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.github.com/graphql");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(request.body._tag).toBe("Uint8Array");
    const body: unknown =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : null;
    expect(body).toEqual({
      query:
        "query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){__typename ... on Blob{oid byteSize}}}}",
      variables: { owner: "acme", name: "source", oid },
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(bodyWith(blob(size)))));
  });
  return Effect.gen(function* () {
    expect(yield* makeGitHubApi(client).blobSize(token, repository, oid)).toBe(size);
  });
});

it.effect.each([{ data: { repository: null } }, bodyWith(null)])(
  "returns no size for an inaccessible or absent object %#",
  (body) =>
    Effect.gen(function* () {
      expect(
        yield* makeGitHubApi(responseClient(body)).blobSize(token, repository, oid),
      ).toBeNull();
    }),
);

it.effect.each([
  { __typename: "Tree", oid },
  { __typename: "Blob", oid },
  { ...blob(4), oid: "0".repeat(40) },
  blob(-1),
  blob(1.5),
  blob(Number.MAX_SAFE_INTEGER + 1),
])("rejects invalid or mismatched blob metadata %#", (object) =>
  Effect.gen(function* () {
    const error = yield* makeGitHubApi(responseClient(bodyWith(object)))
      .blobSize(token, repository, oid)
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "GitHubError",
      operation: "blobSize",
      requestKind: "graphql",
    });
  }),
);

it.effect("keeps GraphQL rate limits retryable", () =>
  Effect.gen(function* () {
    const error = yield* makeGitHubApi(
      responseClient({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
    )
      .blobSize(token, repository, oid)
      .pipe(Effect.flip);
    expect(error).toMatchObject({ operation: "blobSize", requestKind: "graphql" });
    expect(error.retryAt).toBeGreaterThan(0);
  }),
);

it.effect("cancels metadata responses above 4 KiB despite a false content length", () => {
  let pulled = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(4097));
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { headers: { "content-length": "1" } }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).blobSize(token, repository, oid).pipe(Effect.flip);
    expect(error).toMatchObject({ operation: "blobSize", requestKind: "graphql" });
    expect(pulled).toBe(1);
    expect(canceled).toBe(true);
  });
});
