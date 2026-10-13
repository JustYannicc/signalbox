import * as WorkOSClient from "@signalbox/account/WorkOSClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient } from "effect/http";

import type { DrivePerson } from "../drive/DriveMembers.ts";

/**
 * The people a user can share a drive with: anyone with a Signalbox account,
 * found by email, and the work organizations they belong to. WorkOS is the
 * authority for both.
 */

export class DrivePeopleError extends Schema.TaggedError<DrivePeopleError>()("DrivePeopleError", {
  message: Schema.String,
}) {}

export class DrivePeople extends Context.Service<
  DrivePeople,
  {
    readonly findByEmail: (email: string) => Effect.Effect<DrivePerson | null, DrivePeopleError>;
    readonly organizationsOf: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<string>, DrivePeopleError>;
  }
>()("@signalbox/cloud/user/DrivePeople") {}

const nameOf = (user: WorkOSClient.WorkOSUser) =>
  [user.firstName, user.lastName].filter(Boolean).join(" ") || null;

const UNAVAILABLE = "Sharing is unavailable right now. Try again.";

/** WorkOS through `config`; without accounts or an API key nobody can be found. */
export const layerWorkOS = (config: WorkOSClient.WorkOSConfig | undefined) =>
  Layer.effect(
    DrivePeople,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const apiKey = config?.apiKey;
      if (config === undefined || apiKey === undefined) {
        const missing = Effect.fail(
          new DrivePeopleError({ message: "Sharing needs this cloud's WorkOS API key." }),
        );
        return DrivePeople.of({ findByEmail: () => missing, organizationsOf: () => missing });
      }
      const workos = { ...config, apiKey };
      const failed = (cause: unknown) =>
        Effect.logError("WorkOS lookup for sharing failed", { cause }).pipe(
          Effect.andThen(Effect.fail(new DrivePeopleError({ message: UNAVAILABLE }))),
        );
      return DrivePeople.of({
        findByEmail: (email) =>
          WorkOSClient.findUserByEmail(workos, email).pipe(
            Effect.map((user) =>
              user === null ? null : { userId: user.id, email: user.email, name: nameOf(user) },
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.catch(failed),
          ),
        organizationsOf: (userId) =>
          WorkOSClient.listOrganizations(workos, userId).pipe(
            Effect.map((organizations) => organizations.map((organization) => organization.id)),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.catch(failed),
          ),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
