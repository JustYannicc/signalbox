import { QualifierSequenceLifetime } from "./sequenceLifetime.ts";
import {
  collectModelPhysicalRecovery,
  type ModelRecoveryEvidence,
} from "./modelPhysicalRecovery.fixture.ts";
import type { PlacementReleaseProof } from "./placementReleaseObserver.fixture.ts";
// @effect-diagnostics cryptoRandomUUID:off - Raw trace artifacts need unique platform capture IDs outside Effect.
import { ROUTES } from "./routes.ts";
import { QualifierCapabilities } from "./capabilities.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { Lifecycle } from "./lifecycle.ts";
import { ModelController, type Incarnation } from "./modelController.ts";
import { ClaudeDispatch, type ClaudeDispatchStep } from "./claudeDispatch.ts";
import { claudeStepRoute } from "./claudeScenario.ts";
import { ClaudeController } from "./claudeController.ts";
import { requireClaudeAuthorities } from "./claudeAuthorities.ts";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";
import type {
  HarnessProcessPlacementIdentity,
  HarnessProcessPlacementWriter,
} from "../../../../src/harness/HarnessProcessPlacement.ts";
import type { ProcessTerminalEvidence } from "../../../../src/harness/HarnessProcessResume.ts";
import { assert, C4, decoder, errorRecord, fromBase64, jsonBytes } from "./common.ts";

type Step = "turn-1" | "replace" | "turn-2" | "turn-3" | "finish";
export type { ClaudeStepPhase, ClaudeVariant, ClaudeStep } from "./claudeScenario.ts";
import type { ClaudeVariant, ClaudeStep } from "./claudeScenario.ts";
interface StepReceipt {
  schema: "sb1070/step-receipt/v1";
  runId: string;
  step: string;
  status: "completed" | "failed";
  sequence: number;
  mainCommit: string;
  mainTree: string;
  result?: unknown;
  failure?: unknown;
}
export interface WriterRelease {
  sequence: number;
  beforeSequence: number;
  owner: string;
  writer: HarnessProcessPlacementWriter;
  terminals: readonly ProcessTerminalEvidence[];
  releaseProof: PlacementReleaseProof;
}
const sequence: readonly Step[] = ["turn-1", "replace", "turn-2", "turn-3", "finish"];

export class QualifierProof extends QualifierCapabilities<QualifierEnvironment> {
  readonly model = new ModelController(this);
  readonly lifecycle = new Lifecycle(this);
  readonly #steps = new Map<Step, Promise<StepReceipt>>();
  readonly #sequenceLifetime = new QualifierSequenceLifetime(
    this.ctx.storage,
    this.env.RUN_ID,
    this.ctx.id.toString(),
    crypto.randomUUID(),
  );
  #live = false;
  #fatal = false;
  #phase: Step | undefined;
  readonly #tailWaiters = new Map<string, PromiseWithResolvers<void>>();
  readonly #tailTerminals = new Set<string>();
  readonly claude = new ClaudeController(this, this.ctx.storage);
  readonly claudeDispatch = new ClaudeDispatch(this, this.ctx.storage, crypto.randomUUID());
  async commandPhase() {
    if (
      !(await this.ctx.storage.get("execution-owner")) &&
      (await this.ctx.storage.get("observer/calibration-claimed"))
    )
      return "/observer-calibration";
    const claudeStep = await this.ctx.storage.get<ClaudeStep>("claude/active-step");
    if (claudeStep) return claudeStepRoute(claudeStep);
    await this.assertLiveOwner();
    if (this.#phase === "replace") return "/replace/dispatch";
    assert(
      this.#phase?.startsWith("turn-"),
      "Native command arrived outside an active accepted turn",
    );
    const phase = this.#phase;
    assert(phase, "The current accepted command phase is absent");
    return `/turn/${phase.slice(-1)}/dispatch`;
  }
  async config() {
    return await this.configuration();
  }
  environment() {
    return this.env;
  }
  shardOwner() {
    return `combined/${this.env.RUN_ID}`;
  }
  shard() {
    return this.env.PROCESS_EXECUTION_SHARDS.getByName(this.shardOwner());
  }
  async assertLiveOwner() {
    assert(
      this.#live && !this.#fatal,
      "The qualifier execution owner is missing or failed; replay is forbidden",
    );
    const owner = await this.ctx.storage.get("execution-owner");
    assert(owner === this.ctx.id.toString(), "The durable qualifier execution claim changed");
  }
  async state<T>(key: string) {
    const ref = await this.ctx.storage.get<HarnessRunArtifact>(`state/${key}`);
    assert(ref !== undefined, `Required persisted qualifier state is missing: ${key}`);
    const bytes = await this.journal.read(ref);
    return JSON.parse(decoder.decode(bytes), (_key, value) => {
      if (value?.encoding === "base64" && typeof value.value === "string")
        return fromBase64(value.value);
      if (value?.encoding === "bigint" && typeof value.value === "string")
        return BigInt(value.value);
      return value;
    }) as T;
  }
  async saveState(key: string, value: unknown) {
    const record = await this.append(`state-${key}`, value);
    const ref = await this.artifact(`state-value-${key}`, jsonBytes(value));
    await this.ctx.storage.put(`state/${key}`, ref);
    return record;
  }
  async knownTurn(turn: number) {
    return await this.state<{
      turn: number;
      nativeSessionId: string;
      identity: HarnessProcessPlacementIdentity;
      committed: { status: string };
      checkpoint: unknown;
    }>(`turn-${turn}`);
  }
  async runStoreSnapshot() {
    return await this.env.HARNESS_RUN_STORE.getByName(this.env.RUN_ID).execute({
      type: "read",
      runId: this.env.RUN_ID,
    });
  }
  override async prepareModelIncarnation(input: Incarnation) {
    return await this.model.prepare(input);
  }
  override async prepareClaudeIncarnation(input: Parameters<ClaudeController["prepare"]>[0]) {
    return await this.claude.prepare(input);
  }
  async beginClaudeStep(step: ClaudeStep) {
    return await this.claude.begin(step);
  }
  async endClaudeStep(step: ClaudeStep) {
    return await this.claude.end(step);
  }
  async claudeStepForLoader() {
    return await this.claude.active();
  }
  modelTransition() {
    return this.#phase;
  }
  async modelConstructionPhase() {
    await this.assertLiveOwner();
    assert(this.#phase, "Facet construction has no accepted qualifier step");
    return {
      route:
        this.#phase === "replace" ? "/replace/dispatch" : `/turn/${this.#phase.slice(-1)}/dispatch`,
      logicalIncarnation: this.#phase === "replace" ? 1 : this.model.logicalIncarnation(),
    };
  }
  async physicalRecoveryFor(input: Incarnation): Promise<ModelRecoveryEvidence | undefined> {
    const owner = this.shardOwner();
    return collectModelPhysicalRecovery(
      owner,
      input,
      await this.shard().modelRecoveryEvidence(this.env.RUN_ID),
      this.env.PLACEMENT_STORES.getByName(owner),
    );
  }

  async commitModelRecord(record: Record<string, unknown>, artifact: HarnessRunArtifact) {
    assert(Number.isSafeInteger(record.sequence), "Model sequence is invalid");
    const ordinal = record.sequence as number;
    await this.ctx.storage.transaction(async (tx) => {
      const previous = (await tx.get<number>("model/sequence")) ?? 0;
      assert(ordinal === previous + 1, "The model collector has a gap or duplicate");
      await tx.put("model/sequence", ordinal);
      await tx.put(`model/record/${String(ordinal).padStart(10, "0")}`, { ...record, artifact });
    });
    await this.append("model-wire", { ...record, artifact });
  }
  async claudeRunShard(...args: Parameters<ClaudeController["runShard"]>) {
    return await this.claude.runShard(...args);
  }
  async claudeResumeProcess(...args: Parameters<ClaudeController["resumeProcess"]>) {
    return await this.claude.resumeProcess(...args);
  }
  async claudeContinueProcess(...args: Parameters<ClaudeController["continueProcess"]>) {
    return await this.claude.continueProcess(...args);
  }
  async claudeCommitProcessCheckpoint(
    ...args: Parameters<ClaudeController["commitProcessCheckpoint"]>
  ) {
    return await this.claude.commitProcessCheckpoint(...args);
  }
  async claudeStopIdleProcess(...args: Parameters<ClaudeController["stopIdleProcess"]>) {
    return await this.claude.stopIdleProcess(...args);
  }
  async claudeModelRequest(request: Request) {
    return await this.claude.request(request);
  }
  async claudeModelSnapshot(variant: ClaudeVariant) {
    return await this.claude.snapshot(variant);
  }
  async claudeModelRecords(variant: ClaudeVariant) {
    return await this.claude.records(variant);
  }
  async recordWriterRelease(input: Omit<WriterRelease, "sequence">) {
    const event = await this.append("placement-writer-released", input);
    const receipt = { ...input, sequence: event.sequence };
    for (const terminal of input.terminals)
      await this.saveState(`writer-release-${terminal.identity.incarnationNonce}`, receipt);
    return receipt;
  }
  async writerReleaseFor(incarnation: string) {
    const release = await this.state<WriterRelease>(`writer-release-${incarnation}`);
    assert(release, "No persisted old-writer release exists before replacement bootstrap");
    const terminal = release.terminals.find((row) => row.identity.incarnationNonce === incarnation);
    assert(
      terminal?.stopped === true &&
        terminal.joined.invocationRpc &&
        terminal.joined.fetch &&
        terminal.joined.ports,
      "Old process stop/join proof is incomplete",
    );
    const released = await this.env.PLACEMENT_STORES.getByName(release.owner).writerReleased(
      release.owner,
      release.writer,
    );
    assert(released, "The public placement release receipt is absent");
    return release;
  }
  async tailRecords(
    raw: unknown,
    ingress: "outer-platform" | "dynamic-platform" = "dynamic-platform",
  ) {
    const payload = await this.artifact(`raw-tail-${crypto.randomUUID()}`, jsonBytes(raw));
    const receipt = await this.append("raw-tail", { payload, ingress });
    await this.ctx.storage.put(`observer/raw/${String(receipt.sequence).padStart(10, "0")}`, {
      payload,
      ingress,
    });
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      if (item?.outcome === "exceededMemory")
        await this.ctx.storage.put("observer/memory-failure", receipt);
      for (const log of item?.logs ?? [])
        for (const value of log?.message ?? []) {
          if (typeof value !== "string") continue;
          let record;
          try {
            record = JSON.parse(value);
          } catch {
            continue;
          }
          const event = record?.producerEvent;
          if (event?.schema === "sb1070/producer/v1" && event.milestone === "terminal") {
            this.#tailTerminals.add(event.invocationId);
            this.#tailWaiters.get(event.invocationId)?.resolve();
          }
        }
    }
    return receipt;
  }
  private async waitTailTerminal(invocationId: string) {
    if (this.#tailTerminals.has(invocationId)) return;
    let waiter = this.#tailWaiters.get(invocationId);
    if (!waiter) {
      waiter = Promise.withResolvers<void>();
      this.#tailWaiters.set(invocationId, waiter);
    }
    await waiter.promise;
  }
  async guardDiagnostic() {
    assert(this.env.OBSERVER_GUARD_ONLY === "1", "Guard diagnostics are local-only");
    const rows = await this.ctx.storage.list<{ payload: HarnessRunArtifact }>({
      prefix: "journal/record/",
    });
    const records = [];
    for (const [key, row] of rows)
      records.push({ key, ...row, value: decoder.decode(await this.journal.read(row.payload)) });
    return {
      officialNativeStarted: Boolean(await this.ctx.storage.get("execution-owner")),
      records,
    };
  }
  async guardDrain(invocationIds: string[]) {
    assert(this.env.OBSERVER_GUARD_ONLY === "1", "Guard collection is local-only");
    for (const id of invocationIds) await this.waitTailTerminal(id);
    const rows = await this.ctx.storage.list<{ payload: HarnessRunArtifact; ingress: string }>({
      prefix: "observer/raw/",
    });
    const records = [];
    for (const [key, value] of rows)
      records.push({
        key,
        ingress: value.ingress,
        raw: decoder.decode(await this.journal.read(value.payload)),
        payload: value.payload,
      });
    assert(
      !(await this.ctx.storage.get("execution-owner")),
      "The observer guard started an official native process",
    );
    return { records, officialNativeStarted: false, source: (await this.config()).sourcePins };
  }
  async observerCalibration() {
    assert(await this.ctx.storage.get("ready"), "Readiness must precede observer calibration");
    assert(
      !(await this.ctx.storage.get("execution-owner")),
      "Calibration cannot dispatch or replay the native session",
    );
    assert(
      !(await this.ctx.storage.get("observer/calibration-claimed")),
      "Calibration already has a durable claim",
    );
    await this.ctx.storage.put("observer/calibration-claimed", true);
    const result = await this.shard().observerCalibration();
    const config = await this.config();
    const calibration = {
      workerId: config.workerName,
      routePinsSha256: config.observer.routePinsSha256,
      producerListSha256: config.observer.producerListSha256,
      schema: "sb1070/observer-calibration/v1",
      runId: this.env.RUN_ID,
      bundleSha256: this.env.BUNDLE_SHA256,
      status: "passed",
      nativeDispatchCount: 0,
      tailBarrier: "awaited-before-native-claim",
      result,
    };
    await this.ctx.storage.put("observer/calibration", calibration);
    return calibration;
  }
  async ready() {
    const config = await this.config();
    requireClaudeAuthorities(this.env);
    const started = await this.ctx.storage.get("execution-owner");
    assert(started === undefined, "Readiness cannot silently become a repeated native attempt");
    const ready = {
      status: "ready",
      workerId: config.workerName,
      configHash: this.env.CONFIG_SHA256,
      pins: config.sourcePins,
      schema: "sb1070/ready/v1",
      runId: config.runId,
      workerName: config.workerName,
      mainCommit: config.mainCommit,
      mainTree: config.mainTree,
      configSha256: this.env.CONFIG_SHA256,
      bundleSha256: this.env.BUNDLE_SHA256,
      nativeDispatchCount: 0,
      routes: ROUTES,
      C4,
      selfSample: {
        available: false,
        reason:
          "Production Workers exposes no usable JS used heap plus backingStorageSize sampler to this fixture",
      },
      sourcePins: config.sourcePins,
    };
    await this.ctx.storage.put("ready", ready);
    await this.append("readiness", ready);
    return ready;
  }
  async dispatch(step: Step) {
    await this.#sequenceLifetime.check();
    assert(sequence.includes(step), "Unknown qualifier step");
    const existing = await this.ctx.storage.get(`step/${step}/claim`);
    assert(
      existing === undefined && !this.#steps.has(step),
      "This qualifier mutation has already been claimed; do not resubmit it",
    );
    assert(await this.ctx.storage.get("ready"), "Readiness must precede native dispatch");
    assert(
      await this.ctx.storage.get("observer/calibration"),
      "The exact-build observer calibration must precede native dispatch",
    );
    if (step === "turn-1") {
      await this.waitTailTerminal("actual-facet-calibration");
      await this.append("observer-calibration-tail-observed-before-native", {
        invocationId: "actual-facet-calibration",
      });
    }
    const index = sequence.indexOf(step);
    if (index > 0 && step !== "finish") {
      const prior = await this.readReceipt(sequence[index - 1]!);
      assert(
        prior?.status === "completed",
        "The preceding qualifier step has no completed durable receipt",
      );
    }
    if (step === "finish") {
      assert(
        this.#live && (await this.ctx.storage.get("execution-owner")) === this.ctx.id.toString(),
        "The original owner is required for final stop; reset cannot replay it",
      );
    } else if (step !== "turn-1") await this.assertLiveOwner();
    await this.ctx.storage.transaction(async (tx) => {
      assert(
        !(await tx.get(`step/${step}/claim`)),
        "This qualifier mutation already owns a durable claim",
      );
      if (step === "turn-1") {
        assert(
          !(await tx.get("execution-owner")),
          "The official native attempt has already been claimed",
        );
        await tx.put("execution-owner", this.ctx.id.toString());
      }
      await tx.put(`step/${step}/claim`, { status: "reserved" });
    });
    if (step === "turn-1") this.#live = true;
    const claim = await this.append("step-claimed", { step });
    await this.ctx.storage.put(`step/${step}/claim`, claim);
    const operation = this.runStep(step);
    this.#steps.set(step, operation);
    this.ctx.waitUntil(operation.then(() => undefined));
    return {
      schema: "sb1070/dispatch/v1",
      runId: this.env.RUN_ID,
      step,
      claimed: true,
      sequence: claim.sequence,
    };
  }
  private async runStep(step: Step): Promise<StepReceipt> {
    const config = await this.config();
    this.#phase = step;
    try {
      const result =
        step === "replace"
          ? await this.lifecycle.replace()
          : step === "finish"
            ? await this.lifecycle.finish()
            : await this.lifecycle.turn(Number(step.slice(-1)));
      const completed = await this.append("step-completed", { step, result });
      const receipt: StepReceipt = {
        schema: "sb1070/step-receipt/v1",
        runId: config.runId,
        step: step.replace("turn-", "turn/"),
        status: "completed",
        sequence: completed.sequence,
        mainCommit: config.mainCommit,
        mainTree: config.mainTree,
        result,
      };
      await this.saveState(`step-${step}-receipt`, receipt);
      await this.ctx.storage.put(`step/${step}/receipt`, true);
      return receipt;
    } catch (cause) {
      this.#fatal = true;
      const failure = errorRecord(cause);
      const recorded = await this.append("step-first-failure", { step, failure });
      const receipt: StepReceipt = {
        schema: "sb1070/step-receipt/v1",
        runId: config.runId,
        step: step.replace("turn-", "turn/"),
        status: "failed",
        sequence: recorded.sequence,
        mainCommit: config.mainCommit,
        mainTree: config.mainTree,
        failure,
      };
      await this.saveState(`step-${step}-receipt`, receipt);
      await this.ctx.storage.put(`step/${step}/receipt`, true);
      return receipt;
    }
  }
  private async readReceipt(step: Step) {
    if (!(await this.ctx.storage.get(`step/${step}/receipt`))) return undefined;
    return await this.state<StepReceipt>(`step-${step}-receipt`);
  }
  async receipt(step: Step) {
    const persisted = await this.readReceipt(step);
    if (persisted) return persisted;
    const pending = this.#steps.get(step);
    assert(
      pending,
      "The step is unstarted or its owner reset. A missing receipt never authorizes replay",
    );
    return await pending;
  }
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const claudeMessagesHost =
      url.hostname === "model.invalid" ||
      url.hostname === "api.anthropic.com" ||
      url.hostname === "api.us.anthropic.com";
    if (
      claudeMessagesHost &&
      request.method === "POST" &&
      (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens")
    )
      return await this.claudeModelRequest(request);
    if (url.hostname === "model.invalid") return await this.model.fetch(request);
    assert(
      request.headers.get("x-qualifier-run") === this.env.RUN_ID,
      "Qualifier request belongs to another run",
    );

    if (request.method === "POST" && url.pathname !== "/export/blob")
      assert((await request.text()) === "{}", "Qualifier mutations require an empty JSON object");
    if (request.method === "POST" && url.pathname === "/sequence/hold")
      return Response.json(await this.#sequenceLifetime.hold());
    if (request.method === "GET" && url.pathname === "/sequence/held")
      return Response.json(await this.#sequenceLifetime.ready());
    if (request.method === "POST" && url.pathname === "/sequence/release")
      return Response.json(
        await this.#sequenceLifetime.release(
          (await this.readReceipt("finish"))?.status === "completed",
        ),
      );
    if (request.method === "GET" && url.pathname === "/ready")
      return Response.json(await this.ready());
    if (request.method === "POST" && url.pathname === "/observer-calibration")
      return Response.json(await this.observerCalibration());
    const claude = url.pathname.match(
      /^\/claude\/(baseline|hooks)\/(turn\/[123]|replace|finish)\/(dispatch|receipt)$/u,
    );
    if (claude) {
      const variant = claude[1] as ClaudeVariant;
      const step = claude[2]!.replace("turn/", "turn-") as ClaudeDispatchStep;
      if (claude[3] === "dispatch" && request.method === "POST") {
        await this.#sequenceLifetime.check();
        if (step === "turn-1") await this.waitTailTerminal("actual-facet-calibration");
        const claimed = await this.claudeDispatch.dispatch(variant, step);
        this.ctx.waitUntil(this.claudeDispatch.pending(variant, step).then(() => undefined));
        return Response.json(claimed, { status: 202 });
      }
      if (claude[3] === "receipt" && request.method === "GET")
        return new Response(jsonBytes(await this.claudeDispatch.receipt(variant, step)), {
          headers: { "content-type": "application/json" },
        });
    }
    const match = url.pathname.match(/^\/(turn\/[123]|replace|finish)\/(dispatch|receipt)$/);
    if (match) {
      const step = match[1]!.replace("/", "-") as Step;
      if (match[2] === "dispatch" && request.method === "POST")
        return Response.json(await this.dispatch(step), { status: 202 });
      if (match[2] === "receipt" && request.method === "GET")
        return Response.json(await this.receipt(step));
    }
    if (
      request.method === "GET" &&
      url.pathname === "/export/page" &&
      url.searchParams.has("guard-raw")
    )
      return Response.json(await this.guardDrain([]));
    if (
      request.method === "GET" &&
      url.pathname === "/export/page" &&
      url.searchParams.has("guard-diagnostic")
    )
      return Response.json(await this.guardDiagnostic());
    if (request.method === "GET" && url.pathname === "/export/page")
      return Response.json(
        await this.exportPage(
          url.searchParams.get("prefix") ?? "journal/record/",
          url.searchParams.get("startAfter") ?? undefined,
        ),
      );
    if (request.method === "POST" && url.pathname === "/export/blob")
      return new Response(await this.exportBlob(await request.json<HarnessRunArtifact>()), {
        headers: { "content-type": "application/octet-stream" },
      });
    return new Response("Unknown qualifier route", { status: 404 });
  }
}
