import * as Schema from "effect/Schema";
import type * as Redacted from "effect/Redacted";
import {
  decodeDeploy3Registration,
  parseTrustedWriterIds,
  validateDeploy3RegistrationReceipt,
} from "./runtime.ts";
import { controlBody } from "./controlRegistry.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import {
  deploy3BootstrapIdentity,
  deploy3Expiry,
  Deploy3UploadReceiptSchema,
  type Deploy3UploadReceipt,
} from "./expiry.ts";

const encodeDeploy3UploadReceiptJson = Schema.encodeEffect(
  Schema.fromJsonString(Deploy3UploadReceiptSchema),
);

/** Both phases use the same Alchemy resource ID, so arming updates the bootstrap Worker. */
export function deploy3Workload<Bindings>(input: {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly props: Omit<Cloudflare.WorkerProps<Bindings>, "name" | "crons" | "tags">;
  readonly receipt?: Deploy3UploadReceipt;
  readonly registrationJson?: string;
  readonly cleanupTokenValue?: Redacted.Redacted<string>;
  readonly trustedWriterIds?: string;
}) {
  return Effect.gen(function* () {
    const bootstrap = deploy3BootstrapIdentity(input.runId, input.startedAtMs);
    if (input.receipt && input.receipt.workerName !== bootstrap.workerName) {
      throw new Error("Deploy3 arming receipt differs from the bootstrap Worker");
    }
    const deadline = input.receipt ? deploy3Expiry(input.receipt) : undefined;
    const registration = input.registrationJson
      ? decodeDeploy3Registration(input.registrationJson)
      : undefined;
    if (registration && (!input.receipt || !input.cleanupTokenValue || !input.trustedWriterIds)) {
      throw new Error("Deploy3 arming needs the exact registered receipt and expiring token");
    }
    if (registration && input.receipt) {
      parseTrustedWriterIds(input.trustedWriterIds!);
      validateDeploy3RegistrationReceipt(registration, input.receipt);
    }
    const receiptJson = input.receipt
      ? yield* encodeDeploy3UploadReceiptJson(input.receipt).pipe(Effect.orDie)
      : undefined;
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const worker = yield* Cloudflare.Worker("Deploy3Workload", {
      ...input.props,
      name: bootstrap.workerName,
      crons: ["* * * * *"],
      tags: deadline ? [deadline.deadlineTag] : [],
      env: {
        ...input.props.env,
        DEPLOY3_ACCOUNT_ID: accountId,
        ...(registration && input.cleanupTokenValue && receiptJson !== undefined
          ? {
              DEPLOY3_CLEANUP_TOKEN: input.cleanupTokenValue,
              DEPLOY3_RECEIPT: receiptJson,
              DEPLOY3_CONTROL: controlBody(registration).split("\n").slice(1).join("\n"),
              DEPLOY3_CONTROL_WRITER_IDS: input.trustedWriterIds!,
            }
          : {}),
      },
    });
    return {
      worker,
      protection: registration ? "arm-update-submitted" : "bootstrap-only",
      deadlineUtc: deadline?.deadlineUtc,
      cleanupTokenId: registration?.cleanupTokenId,
      cleanupTokenExpiresOn: deadline?.tokenExpiresOn,
    };
  });
}

/** Provisioning uses the existing Alchemy authority; the operator receives this expiring value. */
export function deploy3OperatorToken(input: {
  readonly runId: string;
  readonly startedAtMs: number;
}) {
  return Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const identity = deploy3BootstrapIdentity(input.runId, input.startedAtMs);
    const token = yield* Cloudflare.ApiToken.AccountApiToken("Deploy3OperatorToken", {
      name: `${identity.workerName}-operator`,
      expiresOn: identity.operatorTokenExpiresOn,
      policies: [
        {
          effect: "allow",
          permissionGroups: ["Workers Scripts Write"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });
    return { token, expiresOn: identity.operatorTokenExpiresOn };
  });
}
