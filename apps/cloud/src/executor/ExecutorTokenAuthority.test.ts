import { AuthStandardClientScopes, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as CloudAutomations from "../automations/CloudAutomations.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as ThreadRunner from "../thread/runner/ThreadRunner.ts";
import { claude, hello, liveTurn, turnReport } from "../thread/runner/runnerTestKit.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as DriveSharing from "../user/DriveSharing.ts";
import * as SignInGrants from "../signIn/SignInGrants.ts";
import * as DrivePeople from "../user/DrivePeople.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserPools from "../user/UserPools.ts";
import { projectIdForContext } from "../user/contextProjects.ts";
import {
  authorizeExecutorToken,
  executorFolderLevelMatches,
  executorTurnIsCurrent,
} from "./ExecutorTokenAuthority.ts";
import { executorTokenPurpose, type ExecutorTokenIdentity } from "./ExecutorTokenClaims.ts";
import type { ExecutorTokenBinding } from "./ExecutorTokenBindings.ts";

const USER = "user_executor";
const OWNER = SignalboxContextId.make("org_acme");
const ORIGIN = "https://accounts.example.com/login";
const SOURCE = (folderId: FolderId) => ({ _tag: "folder", folderId }) as const;
const ACTOR = { userId: USER, contextIds: [PERSONAL_CONTEXT_ID, OWNER] };

const compiledOf = (source: string) => {
  const result = compileForCloud(source);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.compiled;
};

const authorityFixture = (options: Parameters<typeof makeMemoryCloud>[0] = {}) =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud({
      ...options,
      people: options.people ?? [
        {
          userId: USER,
          email: "executor@example.com",
          name: "Executor",
          organizations: [OWNER],
        },
      ],
    });
    const user = cloud.userDirectory.forUser(USER);
    yield* user.recordSignIn({ id: USER, email: "executor@example.com" });
    yield* user.syncOrganizations([{ id: OWNER, name: "Acme" }]);

    const { folderId, grantId } = yield* Effect.gen(function* () {
      const folders = yield* UserFolders.UserFolders;
      const grants = yield* SignInGrants.SignInGrants;
      const created = yield* folders.create({ name: "Executor", parentId: null, ownerId: OWNER });
      const folder = created.folders.find(
        (candidate) => candidate.ownerId === OWNER && candidate.name === "Executor",
      );
      if (folder === undefined) throw new Error("The organization folder was not created.");
      const source = SOURCE(folder.id);
      yield* grants.grant({ source, site: "example.com" });
      const answer = yield* grants.check({ requester: USER, source, origin: ORIGIN });
      if (answer._tag !== "allowed") throw new Error("The fixture sign-in grant was not allowed.");
      return { folderId: folder.id, grantId: answer.grant.id };
    }).pipe(Effect.provide(cloud.userObject(USER)));

    return { cloud, user, folderId, grantId };
  });

const tokenFor = (
  identity: ExecutorTokenIdentity,
  fixture: { readonly folderId: FolderId; readonly grantId: string },
  sessionId?: string,
  runnerGeneration?: number,
) => {
  const jti = `executor-test:${identity.thread ?? identity.automation ?? identity.person}:${identity.turn ?? fixture.grantId}`;
  const claims = { ...identity, iat: 1, exp: 60_000, jti };
  const binding: ExecutorTokenBinding = {
    jti,
    identity,
    issuedAt: 1,
    ownerUserId: USER,
    requester: USER,
    source: SOURCE(fixture.folderId),
    origin: ORIGIN,
    grantId: fixture.grantId,
    purpose: executorTokenPurpose(identity),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(runnerGeneration === undefined ? {} : { runnerGeneration }),
    expiresAt: 60_000,
  };
  return { claims, binding };
};

const connectRunner = (runner: ThreadRunner.ThreadRunner["Service"], threadId: ThreadId) =>
  Effect.gen(function* () {
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("expected a machine request");
    yield* runner.ensured(plan.ensure.generation);
    const welcome = yield* runner.hello({
      ...hello(plan.ensure.generation, plan.ensure.token),
      threadId,
    });
    if (welcome._tag !== "welcome") {
      throw new Error(`Runner refused ${welcome.reason}: ${welcome.message}`);
    }
    return { ...plan.ensure, machineClass: plan.machineClass };
  });

const turnIdentity = (
  threadId: ThreadId,
  turnId: string,
  folderId: FolderId,
): ExecutorTokenIdentity => ({
  owner: OWNER,
  level: folderId,
  person: USER,
  thread: threadId,
  turn: turnId,
});

const createThreadHome = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  threadId: ThreadId,
  folderId: FolderId,
) =>
  Effect.gen(function* () {
    const pools = yield* UserPools.UserPools.pipe(Effect.provide(cloud.layerFor(USER)));
    yield* pools.list({ userId: USER });
    const personalPool = cloud.pools.directory.forPool(
      PoolDirectory.poolObjectName(USER, "personal"),
    );
    const login = yield* personalPool.startLogin({ userId: USER }, "claude");
    yield* personalPool.completeLogin(
      { userId: USER },
      `http://localhost/callback?code=c&state=${login.state}`,
    );
    yield* personalPool.loginStatus({ userId: USER }, login.state);
    const service = yield* CloudThreadService.CloudThreadService.pipe(
      Effect.provide(cloud.layerFor(USER)),
    );
    yield* service.launchThread(ACTOR, {
      commandId: CommandId.make(`launch-${threadId}`),
      threadId,
      projectId: projectIdForContext(OWNER),
      title: "Executor authorization",
      modelSelection: claude,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    });
    yield* cloud.settle;
    yield* UserFolders.UserFolders.use((folders) =>
      folders.moveThread({ threadId, folderId }),
    ).pipe(Effect.provide(cloud.userObject(USER)));
  });

const startTurn = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  threadId: ThreadId,
  commandId: string,
) =>
  Effect.gen(function* () {
    const service = yield* CloudThreadService.CloudThreadService.pipe(
      Effect.provide(cloud.layerFor(USER)),
    );
    yield* service.dispatchCommand(ACTOR, {
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(`message-${commandId}`),
      text: "Check Executor authorization.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    });
    const snapshot = yield* service.threadSnapshot(ACTOR, threadId);
    const run = snapshot.projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (run === undefined) throw new Error("The message did not start a thread run.");
    return { runId: run.id, status: run.status };
  });

const automationRunActive = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  input: { readonly runId: string; readonly ownerId: string; readonly level: string },
) =>
  CloudAutomations.CloudAutomations.use((automations) => automations.executorRunActive(input)).pipe(
    Effect.provide(cloud.userObject(USER)),
  );

const automationTool = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  threadId: ThreadId,
  name: string,
  input: unknown,
) =>
  CloudAutomations.CloudAutomations.use((automations) =>
    automations.tool({ threadId: String(threadId) }, name, input),
  ).pipe(Effect.provide(cloud.userObject(USER)));

describe("Executor token live authority", () => {
  it("keeps folder tokens inside the exact current organization folder", () => {
    const claims = { owner: "org_acme", level: "folder_1" };
    const source = { _tag: "folder", folderId: FolderId.make("folder_1") } as const;

    expect(
      executorFolderLevelMatches(claims, source, {
        id: "folder_1",
        ownerId: "org_acme",
      }),
    ).toBe(true);
    expect(
      executorFolderLevelMatches(claims, source, {
        id: "folder_1",
        ownerId: "org_other",
      }),
    ).toBe(false);
    expect(
      executorFolderLevelMatches(
        { owner: "org_acme", level: "org_acme" },
        { _tag: "person" },
        undefined,
      ),
    ).toBe(false);
    expect(
      executorFolderLevelMatches(
        claims,
        { _tag: "folder", folderId: FolderId.make("folder_elsewhere") },
        { id: "folder_elsewhere", ownerId: "org_acme" },
      ),
    ).toBe(false);
  });

  it("requires the exact live run in the thread's current context and level", () => {
    const claims = { owner: "org_acme", level: "folder_1", turn: "run_current" };
    const live = {
      contextId: "org_acme",
      level: "folder_1",
      activeRunId: "run_current",
    };

    expect(executorTurnIsCurrent(claims, live)).toBe(true);
    expect(executorTurnIsCurrent(claims, { ...live, activeRunId: "run_stopped" })).toBe(false);
    expect(executorTurnIsCurrent(claims, { ...live, level: "folder_elsewhere" })).toBe(false);
    expect(executorTurnIsCurrent(claims, { ...live, contextId: "org_other" })).toBe(false);
  });

  it.effect("authorizes only the current real thread run, then rejects it when that run ends", () =>
    Effect.gen(function* () {
      const fixture = yield* authorityFixture();
      const threadId = ThreadId.make("thread_executor_authority");
      yield* createThreadHome(fixture.cloud, threadId, fixture.folderId);

      const firstRun = yield* startTurn(fixture.cloud, threadId, "executor-first-turn");
      expect(["starting", "running", "waiting"]).toContain(firstRun.status);
      const absentLease = tokenFor(
        turnIdentity(threadId, firstRun.runId, fixture.folderId),
        fixture,
        undefined,
        1,
      );
      expect(
        yield* fixture.user.authorizeExecutorToken(absentLease.claims, absentLease.binding),
      ).toBe(false);

      const machine = yield* fixture.cloud.threadRun(
        threadId,
        ThreadRunner.ThreadRunner.use((runner) => connectRunner(runner, threadId)),
      );
      const first = tokenFor(
        turnIdentity(threadId, firstRun.runId, fixture.folderId),
        fixture,
        undefined,
        machine.generation,
      );
      expect(yield* fixture.user.authorizeExecutorToken(first.claims, first.binding)).toBe(true);

      const wrongProfile = {
        ...first,
        binding: { ...first.binding, ownerUserId: "another-user" },
      };
      expect(
        yield* fixture.user.authorizeExecutorToken(wrongProfile.claims, wrongProfile.binding),
      ).toBe(false);
      const wrongPerson = tokenFor(
        { ...turnIdentity(threadId, firstRun.runId, fixture.folderId), person: "another-user" },
        fixture,
      );
      expect(
        yield* fixture.user.authorizeExecutorToken(wrongPerson.claims, wrongPerson.binding),
      ).toBe(false);
      const wrongOrganization = tokenFor(
        {
          ...turnIdentity(threadId, firstRun.runId, fixture.folderId),
          owner: SignalboxContextId.make("org_elsewhere"),
        },
        fixture,
      );
      expect(
        yield* fixture.user.authorizeExecutorToken(
          wrongOrganization.claims,
          wrongOrganization.binding,
        ),
      ).toBe(false);
      const wrongFolder = tokenFor(
        { ...turnIdentity(threadId, firstRun.runId, fixture.folderId), level: "folder_elsewhere" },
        fixture,
      );
      expect(
        yield* fixture.user.authorizeExecutorToken(wrongFolder.claims, wrongFolder.binding),
      ).toBe(false);

      yield* fixture.cloud.threadRun(
        threadId,
        ThreadRunner.ThreadRunner.use((runner) =>
          Effect.gen(function* () {
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started],
            });
            yield* runner.batch({
              generation: machine.generation,
              sequence: 2,
              items: [report.partial],
            });
            yield* runner.batch({
              generation: machine.generation,
              sequence: 3,
              items: [report.full, report.terminal],
            });
          }),
        ),
      );
      expect(yield* fixture.user.authorizeExecutorToken(first.claims, first.binding)).toBe(false);

      const secondRun = yield* startTurn(fixture.cloud, threadId, "executor-second-turn");
      expect(secondRun.runId).not.toBe(firstRun.runId);
      const wrongGeneration = tokenFor(
        turnIdentity(threadId, secondRun.runId, fixture.folderId),
        fixture,
        undefined,
        machine.generation + 1,
      );
      expect(
        yield* fixture.user.authorizeExecutorToken(wrongGeneration.claims, wrongGeneration.binding),
      ).toBe(false);
      const second = tokenFor(
        turnIdentity(threadId, secondRun.runId, fixture.folderId),
        fixture,
        undefined,
        machine.generation,
      );
      expect(yield* fixture.user.authorizeExecutorToken(first.claims, first.binding)).toBe(false);
      expect(yield* fixture.user.authorizeExecutorToken(second.claims, second.binding)).toBe(true);

      yield* fixture.cloud.threadRun(
        threadId,
        ThreadRunner.ThreadRunner.use((runner) =>
          Effect.gen(function* () {
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 4,
              items: [report.started, report.partial],
            });
            yield* runner.disconnected({
              generation: machine.generation,
              connection: 1,
              detail: "test close",
            });
          }),
        ),
      );
      expect(yield* fixture.user.authorizeExecutorToken(second.claims, second.binding)).toBe(false);

      const replacement = yield* fixture.cloud.threadRun(
        threadId,
        ThreadRunner.ThreadRunner.use((runner) =>
          Effect.gen(function* () {
            yield* runner.ended(machine.generation, "test replacement");
            return yield* connectRunner(runner, threadId);
          }),
        ),
      );
      expect(replacement.generation).toBe(machine.generation + 1);
      expect(yield* fixture.user.authorizeExecutorToken(second.claims, second.binding)).toBe(false);
      const continuation = yield* fixture.cloud.threadRun(
        threadId,
        ThreadRunner.ThreadRunner.use((runner) => liveTurn(runner)),
      );
      const oldLease = tokenFor(
        turnIdentity(threadId, continuation.runId, fixture.folderId),
        fixture,
        undefined,
        machine.generation,
      );
      expect(yield* fixture.user.authorizeExecutorToken(oldLease.claims, oldLease.binding)).toBe(
        false,
      );
      const currentLease = tokenFor(
        turnIdentity(threadId, continuation.runId, fixture.folderId),
        fixture,
        undefined,
        replacement.generation,
      );
      expect(
        yield* fixture.user.authorizeExecutorToken(currentLease.claims, currentLease.binding),
      ).toBe(true);
    }),
  );

  it.effect("requires the exact current folder grant, including after revocation and regrant", () =>
    Effect.gen(function* () {
      const fixture = yield* authorityFixture();
      const session = yield* fixture.user.createSession({
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttlMs: 60_000,
      });
      const identity: ExecutorTokenIdentity = {
        owner: OWNER,
        level: fixture.folderId,
        person: USER,
      };
      const stale = tokenFor(identity, fixture, session.sid);
      expect(yield* fixture.user.authorizeExecutorToken(stale.claims, stale.binding)).toBe(true);

      yield* SignInGrants.SignInGrants.use((grants) => grants.revoke(fixture.grantId)).pipe(
        Effect.provide(fixture.cloud.userObject(USER)),
      );
      expect(yield* fixture.user.authorizeExecutorToken(stale.claims, stale.binding)).toBe(false);

      const currentGrantId = yield* Effect.gen(function* () {
        const grants = yield* SignInGrants.SignInGrants;
        yield* grants.grant({ source: SOURCE(fixture.folderId), site: "example.com" });
        const answer = yield* grants.check({
          requester: USER,
          source: SOURCE(fixture.folderId),
          origin: ORIGIN,
        });
        if (answer._tag !== "allowed") throw new Error("The replacement grant was not allowed.");
        return answer.grant.id;
      }).pipe(Effect.provide(fixture.cloud.userObject(USER)));
      expect(currentGrantId).not.toBe(fixture.grantId);
      expect(yield* fixture.user.authorizeExecutorToken(stale.claims, stale.binding)).toBe(false);
      const current = tokenFor(identity, { ...fixture, grantId: currentGrantId }, session.sid);
      expect(yield* fixture.user.authorizeExecutorToken(current.claims, current.binding)).toBe(
        true,
      );
    }),
  );

  it.effect("rejects a legacy mixed-role token before reading membership or source grants", () =>
    Effect.gen(function* () {
      const fixture = yield* authorityFixture();
      const personToken = tokenFor(
        { owner: OWNER, level: fixture.folderId, person: USER },
        fixture,
      );
      const legacyIdentity = { ...personToken.binding.identity, automation: "sweep_legacy" };
      const claims = { ...personToken.claims, automation: "sweep_legacy" };
      const binding = {
        ...personToken.binding,
        identity: legacyIdentity,
        purpose: "background-person" as const,
      };
      let membershipReads = 0;
      let sourceGrantChecks = 0;
      const people = DrivePeople.DrivePeople.of({
        findByEmail: () => Effect.succeed(null),
        organizationsOf: () => {
          membershipReads++;
          return Effect.succeed([OWNER]);
        },
      });
      const grants = yield* SignInGrants.SignInGrants.pipe(
        Effect.provide(fixture.cloud.userObject(USER)),
      );
      const observedGrants = SignInGrants.SignInGrants.of({
        ...grants,
        check: (input) => {
          sourceGrantChecks++;
          return grants.check(input);
        },
      });
      const authorized = yield* authorizeExecutorToken(claims, binding).pipe(
        Effect.provideService(DrivePeople.DrivePeople, people),
        Effect.provideService(SignInGrants.SignInGrants, observedGrants),
        Effect.provide(fixture.cloud.userObject(USER)),
      );

      expect(authorized).toBe(false);
      expect(membershipReads).toBe(0);
      expect(sourceGrantChecks).toBe(0);
    }),
  );

  it.effect("requires an unended interactive Signalbox session", () =>
    Effect.gen(function* () {
      const fixture = yield* authorityFixture();
      const session = yield* fixture.user.createSession({
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttlMs: 60_000,
      });
      const token = tokenFor(
        { owner: OWNER, level: fixture.folderId, person: USER },
        fixture,
        session.sid,
      );
      expect(yield* fixture.user.authorizeExecutorToken(token.claims, token.binding)).toBe(true);
      expect(yield* fixture.user.revokeSession(session.sid)).toBe(true);
      expect(yield* fixture.user.authorizeExecutorToken(token.claims, token.binding)).toBe(false);
    }),
  );

  it.effect("rechecks fresh organization membership and rejects a removed or missing person", () =>
    Effect.gen(function* () {
      let organizations: ReadonlyArray<string> = [OWNER];
      const people = [
        {
          userId: USER,
          email: "executor@example.com",
          name: "Executor",
          get organizations() {
            return organizations;
          },
        },
      ];
      const fixture = yield* authorityFixture({ people });
      const session = yield* fixture.user.createSession({
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttlMs: 60_000,
      });
      const token = tokenFor(
        { owner: OWNER, level: fixture.folderId, person: USER },
        fixture,
        session.sid,
      );
      expect(yield* fixture.user.authorizeExecutorToken(token.claims, token.binding)).toBe(true);
      organizations = [];
      expect(yield* fixture.user.authorizeExecutorToken(token.claims, token.binding)).toBe(false);

      const missing = yield* authorityFixture({ people: [] });
      const missingSession = yield* missing.user.createSession({
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttlMs: 60_000,
      });
      const missingToken = tokenFor(
        { owner: OWNER, level: missing.folderId, person: USER },
        missing,
        missingSession.sid,
      );
      expect(
        yield* missing.user.authorizeExecutorToken(missingToken.claims, missingToken.binding),
      ).toBe(false);
    }),
  );

  it.effect("fails closed when the fresh organization membership service errors", () =>
    Effect.gen(function* () {
      const fixture = yield* authorityFixture();
      const session = yield* fixture.user.createSession({
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttlMs: 60_000,
      });
      const token = tokenFor(
        { owner: OWNER, level: fixture.folderId, person: USER },
        fixture,
        session.sid,
      );
      const people = DrivePeople.DrivePeople.of({
        findByEmail: () => Effect.succeed(null),
        organizationsOf: () =>
          Effect.fail(new DrivePeople.DrivePeopleError({ message: "Membership lookup failed." })),
      });
      const authorized = yield* authorizeExecutorToken(token.claims, token.binding).pipe(
        Effect.provideService(DrivePeople.DrivePeople, people),
        Effect.provide(fixture.cloud.userObject(USER)),
      );
      expect(authorized).toBe(false);
    }),
  );

  it.effect("authorizes a running automation only at its current folder and owner", () =>
    Effect.gen(function* () {
      const fixture = yield* authorityFixture();
      const drive = yield* DriveSharing.DriveSharing.use((sharing) =>
        sharing.create({ contextId: OWNER, name: "Executor automation" }),
      ).pipe(Effect.provide(fixture.cloud.userObject(USER)));
      const automationFolder = yield* Effect.gen(function* () {
        const folders = yield* UserFolders.UserFolders;
        const grants = yield* SignInGrants.SignInGrants;
        const state = yield* folders.state;
        const folder = state.tree.folders.find(
          (candidate) => candidate.driveId === drive.id && candidate.ownerId === OWNER,
        );
        if (folder === undefined) throw new Error("The shared drive folder was not created.");
        const source = SOURCE(folder.id);
        yield* grants.grant({ source, site: "example.com" });
        const allowed = yield* grants.check({ requester: USER, source, origin: ORIGIN });
        if (allowed._tag !== "allowed")
          throw new Error("The folder sign-in grant was not allowed.");
        return { folderId: folder.id, grantId: allowed.grant.id };
      }).pipe(Effect.provide(fixture.cloud.userObject(USER)));

      const threadId = ThreadId.make("thread_executor_automation");
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(fixture.cloud.layerFor(USER)),
      );
      yield* service.launchThread(ACTOR, {
        commandId: CommandId.make("launch-executor-automation"),
        threadId,
        projectId: drive.projectId,
        title: "Executor automation authority",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      yield* fixture.cloud.settle;

      const source = `export const meta = { name: "Executor authority", triggers: [] } as const;
export default workflow(async (w) => {
  await w.waitFor("Finish the test run", { on: "drive.changed", timeout: { days: 1 } });
  return "done";
});`;
      const saved = (yield* automationTool(fixture.cloud, threadId, "automation_save", {
        source,
        compiled: compiledOf(source),
      })) as { readonly ok: boolean; readonly automation: { readonly automationId: string } };
      expect(saved.ok).toBe(true);
      const started = (yield* automationTool(fixture.cloud, threadId, "automation_run", {
        automationId: saved.automation.automationId,
      })) as { readonly run: { readonly runId: string } };
      yield* fixture.cloud.settle;

      const identity: ExecutorTokenIdentity = {
        owner: OWNER,
        level: automationFolder.folderId,
        thread: threadId,
        turn: "correlation_only",
        automation: started.run.runId,
      };
      const token = tokenFor(identity, {
        folderId: automationFolder.folderId,
        grantId: automationFolder.grantId,
      });
      expect(yield* fixture.user.authorizeExecutorToken(token.claims, token.binding)).toBe(true);
      expect(
        yield* automationRunActive(fixture.cloud, {
          runId: started.run.runId,
          ownerId: OWNER,
          level: automationFolder.folderId,
        }),
      ).toBe(true);
      expect(
        yield* automationRunActive(fixture.cloud, {
          runId: started.run.runId,
          ownerId: SignalboxContextId.make("org_elsewhere"),
          level: automationFolder.folderId,
        }),
      ).toBe(false);
      expect(
        yield* automationRunActive(fixture.cloud, {
          runId: started.run.runId,
          ownerId: OWNER,
          level: fixture.folderId,
        }),
      ).toBe(false);
      const wrongRun = tokenFor(
        { ...identity, automation: "automation_run_unknown" },
        { folderId: automationFolder.folderId, grantId: automationFolder.grantId },
      );
      expect(yield* fixture.user.authorizeExecutorToken(wrongRun.claims, wrongRun.binding)).toBe(
        false,
      );

      yield* WorkflowEngine.WorkflowEngine.use((engine) =>
        engine.cancelRun(started.run.runId),
      ).pipe(Effect.provide(fixture.cloud.userObject(USER)));
      yield* fixture.cloud.settle;
      const finished = yield* WorkflowEngine.WorkflowEngine.use((engine) =>
        engine.getRun(started.run.runId),
      ).pipe(Effect.provide(fixture.cloud.userObject(USER)));
      expect(finished.run.status).toBe("cancelled");
      expect(
        yield* automationRunActive(fixture.cloud, {
          runId: started.run.runId,
          ownerId: OWNER,
          level: automationFolder.folderId,
        }),
      ).toBe(false);
      expect(yield* fixture.user.authorizeExecutorToken(token.claims, token.binding)).toBe(false);
    }),
  );
});
