import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Deploy3Plan, validateDeploy3Plan } from "./deploymentPlan.ts";
import { deploy3CleanupToken, deploy3Expiry } from "./expiry.ts";
import { deploy3OperatorToken } from "./stack.ts";

const decodeDeploy3PlanJson = Schema.decodeEffect(Schema.fromJsonString(Deploy3Plan));

/** The existing provisioning authority creates credentials; the workload stack uses the expiring operator token. */
export default Alchemy.Stack(
  "Signalbox1070Deploy3Credentials",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const fs = yield* FileSystem.FileSystem;
    const file = yield* Config.String("DEPLOY3_PLAN_FILE");
    const plan = validateDeploy3Plan(
      yield* decodeDeploy3PlanJson(yield* fs.readFileString(file).pipe(Effect.orDie)).pipe(
        Effect.orDie,
      ),
      stage,
    );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const operator = yield* deploy3OperatorToken(plan);
    const cleanup = plan.receipt
      ? yield* Cloudflare.ApiToken.AccountApiToken(
          "Deploy3DeadlineToken",
          deploy3CleanupToken(plan.receipt, accountId),
        )
      : undefined;
    return {
      operatorTokenId: operator.token.tokenId,
      operatorExpiresOn: operator.expiresOn,
      operatorValue: operator.token.value,
      cleanupTokenId: cleanup?.tokenId,
      cleanupValue: cleanup?.value,
      cleanupExpiresOn: plan.receipt ? deploy3Expiry(plan.receipt).tokenExpiresOn : undefined,
    };
  }),
);
