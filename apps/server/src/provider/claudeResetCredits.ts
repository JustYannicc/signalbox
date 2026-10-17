import {
  ClaimResponse,
  CLAIM_OUTCOMES,
  RESET_CREDIT_FAILURES,
  claudeResetCreditsToContract,
} from "@t3tools/provider-core/server/resetCredits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export {
  ClaimResponse,
  CLAIM_OUTCOMES,
  RESET_CREDIT_FAILURES,
  claudeResetCreditsToContract,
  type ClaudeResetGrant,
} from "@t3tools/provider-core/server/resetCredits";

const API_BASE = "https://api.anthropic.com";
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
});
const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});
const UsageResponse = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
class ClaudeResetCreditError extends Schema.TaggedError<ClaudeResetCreditError>()(
  "ClaudeResetCreditError",
  {
    reason: Schema.Literals(
      Object.keys(RESET_CREDIT_FAILURES) as Array<keyof typeof RESET_CREDIT_FAILURES>,
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return RESET_CREDIT_FAILURES[this.reason];
  }
}

const isClaudeResetCreditError = Schema.is(ClaudeResetCreditError);

/**
 * An unanswered or unconfirmed claim retries with the same request id.
 */
export const isSettledClaudeResetCreditFailure = (error: unknown) =>
  isClaudeResetCreditError(error) &&
  error.reason !== "requestFailed" &&
  error.reason !== "unconfirmed";

const readJson = <S extends Schema.Top>(schema: S, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    );
  });

const readAccessToken = (configDir: string) =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "darwin") return undefined;
    const path = yield* Path.Path;
    const credentials = yield* readJson(Credentials, path.join(configDir, ".credentials.json"));
    return credentials.claudeAiOauth?.accessToken?.trim() || undefined;
  });

const withClaudeHeaders = (token: string, version: string) =>
  HttpClientRequest.setHeaders({
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": `claude-cli/${version} (external, cli)`,
  });

export const readClaudeResetCredits = Effect.fn("readClaudeResetCredits")(
  function* (configDir: string, version: string) {
    const token = yield* readAccessToken(configDir);
    if (!token) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
        urlParams: { cedar_ember: "1", skip_spend: "1" },
      }).pipe(withClaudeHeaders(token, version)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(UsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return claudeResetCreditsToContract(
      body.cedar_ember,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);

export const readClaudeOrganizationId = (accountConfigPath: string) =>
  readJson(Config, accountConfigPath).pipe(
    Effect.map((config) => config.oauthAccount?.organizationUuid?.trim() || undefined),
    Effect.orElseSucceed(() => undefined),
  );

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

/**
 * `requestId` is the idempotency key: a retry with the same id is the same
 * claim.
 */
export const consumeClaudeResetCredit = Effect.fn("consumeClaudeResetCredit")(function* (input: {
  readonly configDir: string;
  readonly accountConfigPath: string;
  readonly version: string;
  readonly grantId: string;
  readonly requestId: string;
}) {
  if (!GRANT_ID.test(input.grantId) || !REQUEST_ID.test(input.requestId)) {
    return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
  }
  const token = yield* readAccessToken(input.configDir).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "loginUnreadable", cause })),
  );
  const config = yield* readJson(Config, input.accountConfigPath).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "accountUnreadable", cause })),
  );
  const organization = config.oauthAccount?.organizationUuid?.trim();
  if (!token || !organization) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(
        new URL(
          `/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
          API_BASE,
        ),
      ).pipe(
        withClaudeHeaders(token, input.version),
        HttpClientRequest.bodyJsonUnsafe({
          program: PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
      ),
    )
    .pipe(
      Effect.timeout("25 seconds"),
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
  if (response.status === 429) {
    return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ClaimResponse)),
    Effect.timeout("25 seconds"),
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
  );
  if (body.result === "cooldown") {
    return yield* new ClaudeResetCreditError({ reason: "coolingDown" });
  }
  // Claude could not say whether the claim landed, so, like the CLI, keep the
  // request id and let the retry ask about the same claim.
  if (body.result === "unavailable") {
    return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
  }
  return CLAIM_OUTCOMES[body.result];
});
