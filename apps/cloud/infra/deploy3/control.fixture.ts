import { bootstrapBody } from "./bootstrapRegistry.ts";
import { deploy3BootstrapIdentity } from "./expiry.ts";
import * as Schema from "effect/Schema";
import { controlBody, type Deploy3ControlComment } from "./controlRegistry.ts";
import { deploy3Expiry } from "./expiry.ts";
import { fixtureEnvironment, fixtureReceipt, scheduledControlPlane } from "./scheduled.fixture.ts";
import { deploy3RegistryApi } from "./registryGitHub.ts";

export const controlRegistration = {
  kind: "registered" as const,
  runId: "deadbeef",
  workerName: fixtureReceipt.workerName,
  workerId: fixtureReceipt.workerId,
  deployedAtUtc: fixtureReceipt.receivedAtUtc,
  deadlineUtc: deploy3Expiry(fixtureReceipt).deadlineUtc,
  namespaceIds: ["owned-namespace"],
  tailIds: ["owned-tail"],
  cleanupTokenId: "d".repeat(32),
  cleanupTokenExpiresOn: deploy3Expiry(fixtureReceipt).tokenExpiresOn,
  owners: [
    { owner: "1070" as const, writerId: 101 },
    { owner: "1255" as const, writerId: 102 },
  ],
};

const decodeCommentBody = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String })),
);

export const bootstrapRegistration = {
  runId: "deadbeef",
  workerName: fixtureReceipt.workerName,
  startedAtUtc: "2026-10-29T12:00:00.000Z",
  operatorTokenId: "e".repeat(32),
  operatorTokenExpiresOn: deploy3BootstrapIdentity(
    "deadbeef",
    Date.parse("2026-10-29T12:00:00.000Z"),
  ).operatorTokenExpiresOn,
  owners: ["1070" as const, "1255" as const],
};

export function controlFixture() {
  const comments: Deploy3ControlComment[] = [
    { id: 1, user: { id: 101 }, body: controlBody(controlRegistration) },
  ];
  const cf = scheduledControlPlane();
  const bootstrapComment = {
    id: 100,
    user: { id: 101 },
    body: bootstrapBody(bootstrapRegistration),
  };
  let tokenStatus = "active";
  let tokenExpiresOn = controlRegistration.cleanupTokenExpiresOn;
  let failPublicRead = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      const auth = new Headers(init?.headers).get("authorization");
      if (init?.method === "POST") {
        if (!auth) return Response.json({}, { status: 401 });
        const { body } = decodeCommentBody(String(init.body));
        const row = {
          id: comments.length + 1,
          user: { id: auth.endsWith("owner1255") ? 102 : 101 },
          body,
        };
        comments.push(row);
        return Response.json(row, { status: 201 });
      }
      if (!auth && failPublicRead) return Response.json({}, { status: 503 });
      if (url.pathname.includes("/issues/comments/"))
        return Response.json(
          comments.find((row) => String(row.id) === url.pathname.split("/").at(-1)),
        );
      return Response.json([...comments, bootstrapComment]);
    }
    if (url.pathname.includes("/tokens/")) {
      return Response.json({
        success: true,
        result: {
          id: url.pathname.endsWith(bootstrapRegistration.operatorTokenId)
            ? bootstrapRegistration.operatorTokenId
            : controlRegistration.cleanupTokenId,
          status: url.pathname.endsWith(bootstrapRegistration.operatorTokenId)
            ? "expired"
            : tokenStatus,
          expires_on: url.pathname.endsWith(bootstrapRegistration.operatorTokenId)
            ? bootstrapRegistration.operatorTokenExpiresOn
            : tokenExpiresOn,
        },
      });
    }
    return cf.fetchImpl(input, init);
  };
  const api = (owner = "owner1070") =>
    deploy3RegistryApi({
      token: async () => owner,
      trustedWriterIds: [101, 102],
      fetchImpl,
    });
  return {
    comments,
    cf,
    fetchImpl,
    api,
    setTokenExpiry(value: string) {
      tokenExpiresOn = value;
    },
    expireToken() {
      tokenStatus = "expired";
    },
    failPublicRead() {
      failPublicRead = true;
    },
    env: {
      ...fixtureEnvironment,
      DEPLOY3_CONTROL: JSON.stringify(controlRegistration),
      DEPLOY3_CONTROL_WRITER_IDS: "101,102",
    },
  };
}
