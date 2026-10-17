import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";

import * as CloudAutomations from "../automations/CloudAutomations.ts";
import * as SignInGrants from "../signIn/SignInGrants.ts";
import { activeRun } from "../thread/runLifecycle.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as DrivePeople from "../user/DrivePeople.ts";
import * as UserStore from "../user/UserStore.ts";
import {
  decodeExecutorAuthorizationClaims,
  executorTokenPurpose,
  roleOf,
  type ExecutorAuthorizationClaims,
} from "./ExecutorTokenClaims.ts";
import {
  executorTokenBindingMatchesIdentity,
  type ExecutorTokenBinding,
} from "./ExecutorTokenBindings.ts";

export const executorFolderLevelMatches = (
  claims: Pick<ExecutorAuthorizationClaims, "owner" | "level">,
  source: ExecutorTokenBinding["source"],
  folder: { readonly id: string; readonly ownerId: string } | undefined,
): boolean =>
  claims.level !== claims.owner &&
  source._tag === "folder" &&
  source.folderId === claims.level &&
  folder !== undefined &&
  folder.id === claims.level &&
  folder.ownerId === claims.owner;

export const executorTurnIsCurrent = (
  claims: Pick<ExecutorAuthorizationClaims, "owner" | "level" | "turn">,
  current: {
    readonly contextId: string | null;
    readonly level: string | null;
    readonly activeRunId: string | null;
  },
): boolean =>
  current.contextId === claims.owner &&
  current.level === claims.level &&
  current.activeRunId === claims.turn;

/** Checks Signalbox authority; the credential service resolves its current source separately. */
export const authorizeExecutorToken = (claimsValue: unknown, binding: ExecutorTokenBinding) =>
  Effect.gen(function* () {
    const claims = decodeExecutorAuthorizationClaims(claimsValue);
    if (claims === null || !executorTokenBindingMatchesIdentity(binding, claims)) return false;
    if (binding.purpose !== executorTokenPurpose(claims)) return false;

    const profile = yield* UserStore.UserStore.use((store) => store.profile);
    if (profile === null || profile.id !== binding.ownerUserId) return false;
    if (claims.person !== undefined && claims.person !== profile.id) return false;

    const folderState = yield* UserFolders.UserFolders.use((folders) => folders.state);
    const owner = folderState.contexts.find(
      (context) => context.id === claims.owner && context.kind === "organization",
    );
    if (owner === undefined) return false;
    const currentOrganizations = yield* DrivePeople.DrivePeople.use((people) =>
      people.organizationsOf(profile.id),
    );
    if (!currentOrganizations.includes(claims.owner)) return false;

    // Top-level personal access needs the real WorkOS mapping from #235. The
    // current `personal` context id is only a UI sentinel, never a vault id.
    const folder = folderState.tree.folders.find((candidate) => candidate.id === claims.level);
    if (
      claims.owner === PERSONAL_CONTEXT_ID ||
      !executorFolderLevelMatches(claims, binding.source, folder)
    ) {
      return false;
    }

    const grant = yield* SignInGrants.SignInGrants.use((grants) =>
      grants.check({
        requester: binding.requester,
        source: binding.source,
        origin: binding.origin,
      }),
    );
    if (grant._tag !== "allowed" || grant.grant.id !== binding.grantId) return false;

    switch (roleOf(claims)) {
      case "person": {
        const sessionId = binding.sessionId;
        if (binding.purpose !== "interactive-person" || sessionId === undefined) {
          return false;
        }
        // Person authority always needs a live Signalbox session.
        return (yield* UserStore.UserStore.use((store) => store.findSession(sessionId))) !== null;
      }
      case "turn": {
        if (
          binding.purpose !== "turn" ||
          claims.thread === undefined ||
          claims.turn === undefined
        ) {
          return false;
        }
        const actor = {
          userId: profile.id,
          contextIds: folderState.contexts.map((context) => context.id),
        };
        const thread = ThreadDirectory.ThreadDirectory.use((directory) =>
          Effect.gen(function* () {
            const handle = directory.forThread(ThreadId.make(claims.thread!));
            const [summary, snapshot, home] = yield* Effect.all([
              handle.summary(actor),
              handle.snapshot(actor),
              UserFolders.UserFolders.use((folders) =>
                folders.threadHome(ThreadId.make(claims.thread!)),
              ),
            ]);
            return {
              summary,
              activeRunId: activeRun(snapshot.projection)?.id ?? null,
              level: home.home ?? summary?.contextId ?? null,
            };
          }).pipe(Effect.catchCause(() => Effect.succeed(null))),
        );
        const current = yield* thread;
        return (
          current !== null &&
          current.summary !== null &&
          executorTurnIsCurrent(claims, {
            contextId: current.summary.contextId,
            level: current.level,
            activeRunId: current.activeRunId,
          })
        );
      }
      case "automation": {
        if (binding.purpose !== "automation" || claims.automation === undefined) return false;
        // A correlated thread/turn is trace context only. The live automation
        // run is the authority, even when the correlation has since ended.
        const service = yield* Effect.serviceOption(CloudAutomations.CloudAutomations);
        if (service._tag === "None") return false;
        return yield* service.value
          .executorRunActive({
            runId: claims.automation,
            ownerId: claims.owner,
            level: claims.level,
          })
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
      }
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));
