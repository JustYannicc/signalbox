import type { AccountProfile } from "@t3tools/contracts/account";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/** Profile readers do not need the user store's migrations and their service dependencies. */
export class UserProfile extends Context.Service<
  UserProfile,
  { readonly current: Effect.Effect<AccountProfile | null, SqlError> }
>()("@signalbox/cloud/user/UserProfile") {}
