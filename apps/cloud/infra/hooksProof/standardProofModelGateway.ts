import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import * as Effect from "effect/Effect";

import type {
  ThreadHarnessActiveAttempt,
  ThreadHarnessHookAuthority,
} from "../../src/hooks/ThreadHarnessHooks.ts";
import { makeModelAccess } from "../../src/models/testing.ts";

export const STANDARD_PROOF_MODEL_POOL_ID = "proof-resolved-pool";
export const STANDARD_PROOF_MODEL_ID = "proof-small-model";

type StatusNote = { readonly nextStep: string; readonly progress: string };
type Purpose = "unregistered-probe" | "status" | "native";
type Binding = {
  readonly purpose: Purpose;
  readonly attempt: ThreadHarnessActiveAttempt;
  readonly attemptKey: string;
  readonly poolId: string;
  readonly model: string;
  readonly signal: AbortSignal;
  readonly placeholderNames: ReadonlyArray<string>;
};
type ForwardEvidence = {
  readonly pool: { readonly poolId: string };
  readonly path: string;
  readonly thread: string;
  readonly runId: string;
  readonly method: string;
  readonly model: string;
  readonly responseStatus: number;
  readonly body: string;
  readonly scrubbed: boolean;
};

const attemptKey = (a: ThreadHarnessActiveAttempt) =>
  `${a.threadId}/${a.runId}/${a.attemptId}/${a.generation}`;
const sameAttempt = (a: ThreadHarnessActiveAttempt, b: ThreadHarnessActiveAttempt) =>
  a.threadId === b.threadId &&
  a.runId === b.runId &&
  a.attemptId === b.attemptId &&
  a.generation === b.generation;
const encode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const modelIn = async (request: Request) => {
  try {
    const body: unknown = await request.clone().json();
    return body !== null &&
      typeof body === "object" &&
      "model" in body &&
      typeof body.model === "string"
      ? body.model
      : "unknown";
  } catch {
    return "unknown";
  }
};

export async function createStandardProofModelGateway(input: {
  readonly authority: ThreadHarnessHookAuthority;
  readonly assertActive: (signal: AbortSignal) => void;
  readonly registered: () => ReadonlyArray<SecretValue> | null;
  readonly completeResponse: StatusNote;
  readonly forward: (request: Request) => Promise<Response>;
}) {
  const statusForwards: Array<ForwardEvidence> = [];
  const nativeForwards: Array<ForwardEvidence> = [];
  const bindings = new Map<string, Binding>();
  let sequence = 0;
  let authorizationCount = 0;
  let forwardCalls = 0;

  const bind = (
    purpose: Purpose,
    poolId: string,
    model: string,
    signal: AbortSignal,
    placeholderNames: ReadonlyArray<string>,
    requestedAttempt?: string,
  ) => {
    signal.throwIfAborted();
    input.assertActive(signal);
    const attempt = input.authority.activeAttempt();
    if (attempt === null || attempt.threadId !== input.authority.threadId) {
      throw new Error("Standard proof has no current attempt for this thread");
    }
    const key = attemptKey(attempt);
    if (requestedAttempt !== undefined && requestedAttempt !== key) {
      throw new Error("Standard proof model request used a stale attempt");
    }
    const id = ++sequence;
    const token = `sbm1.${encode(String(attempt.threadId))}.${encode(`${key}\n${poolId}\n${model}\n${purpose}\n${id}`)}`;
    bindings.set(token, {
      purpose,
      attempt,
      attemptKey: key,
      poolId,
      model,
      signal,
      placeholderNames,
    });
    return token;
  };

  const modelAuthority = {
    async authorizeThread(threadId, token, provider) {
      authorizationCount += 1;
      const binding = bindings.get(token);
      const active = input.authority.activeAttempt();
      if (
        binding === undefined ||
        provider !== "anthropic" ||
        threadId !== input.authority.threadId ||
        active === null ||
        !sameAttempt(active, binding.attempt)
      )
        return { _tag: "denied" as const, reason: "Invalid standard proof model binding" };
      try {
        binding.signal.throwIfAborted();
        input.assertActive(binding.signal);
      } catch {
        return { _tag: "denied" as const, reason: "Standard proof attempt ended" };
      }
      const secrets = input.registered();
      if (binding.purpose === "unregistered-probe" || secrets === null) {
        return {
          _tag: "unregistered" as const,
          runId: binding.attempt.runId,
          traceId: token,
          reason: "Proof secrets are not registered",
        };
      }
      return {
        _tag: "granted" as const,
        runId: binding.attempt.runId,
        traceId: token,
        pool: { objectName: binding.poolId, userId: "standard-proof-test-user" },
        secrets,
      };
    },
    async authorizeLocal() {
      return { _tag: "denied" as const, reason: "Local keys are outside this proof" };
    },
    async forward(pool, path, request, thread, trace) {
      forwardCalls += 1;
      const binding = trace === undefined ? undefined : bindings.get(trace.traceId);
      const active = input.authority.activeAttempt();
      if (
        binding === undefined ||
        thread !== String(binding.attempt.threadId) ||
        trace?.runId !== binding.attempt.runId ||
        pool.objectName !== binding.poolId ||
        active === null ||
        !sameAttempt(active, binding.attempt)
      )
        return { _tag: "denied" as const, reason: "Invalid standard proof forward binding" };
      try {
        binding.signal.throwIfAborted();
        input.assertActive(binding.signal);
      } catch {
        return { _tag: "denied" as const, reason: "Standard proof attempt ended" };
      }
      const secrets = input.registered();
      if (secrets === null || (await modelIn(request)) !== binding.model) {
        return { _tag: "denied" as const, reason: "Standard proof route changed" };
      }
      const body = await request.clone().text();
      const scrubbed =
        secrets.every((secret) => secret.value.length === 0 || !body.includes(secret.value)) &&
        binding.placeholderNames.every((name) => body.includes(secretPlaceholder(name)));
      try {
        binding.signal.throwIfAborted();
        input.assertActive(binding.signal);
        const current = input.authority.activeAttempt();
        if (current === null || !sameAttempt(current, binding.attempt)) {
          return { _tag: "denied" as const, reason: "Standard proof attempt ended" };
        }
      } catch {
        return { _tag: "denied" as const, reason: "Standard proof attempt ended" };
      }
      const response = scrubbed
        ? binding.purpose === "status" && binding.model === STANDARD_PROOF_MODEL_ID
          ? Response.json(input.completeResponse)
          : binding.purpose === "native"
            ? await input.forward(request)
            : new Response("Unknown test pool model", { status: 400 })
        : new Response("ModelAccess did not scrub the proof request", { status: 403 });
      const evidence = {
        pool: { poolId: binding.poolId },
        path,
        thread: String(binding.attempt.threadId),
        runId: String(binding.attempt.runId),
        method: request.method,
        model: binding.model,
        responseStatus: response.status,
        body: scrubbed ? body : "[omitted because secret scrubbing failed]",
        scrubbed,
      } satisfies ForwardEvidence;
      (binding.purpose === "status" ? statusForwards : nativeForwards).push(evidence);
      return scrubbed
        ? { _tag: "forwarded" as const, response, upstreamMs: 0 }
        : { _tag: "denied" as const, reason: "ModelAccess did not scrub the proof request" };
    },
    async recordThread() {},
    async recordLocal() {},
  } satisfies Parameters<typeof makeModelAccess>[0];

  const access = await Effect.runPromise(makeModelAccess(modelAuthority));
  const probeSignal = new AbortController().signal;
  const probeActive = input.authority.activeAttempt();
  if (probeActive === null) throw new Error("Standard proof has no active attempt for its probe");
  const probeToken = bind(
    "unregistered-probe",
    STANDARD_PROOF_MODEL_POOL_ID,
    STANDARD_PROOF_MODEL_ID,
    probeSignal,
    [],
  );
  const beforeProbeForwards = forwardCalls;
  const probe = await access.serve({
    token: probeToken,
    provider: "anthropic",
    path: "/v1/messages",
    request: new Request("http://standard-proof.invalid/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: STANDARD_PROOF_MODEL_ID, messages: [] }),
    }),
  });
  const probeForwardedCalls = forwardCalls - beforeProbeForwards;
  const probeDenied =
    probe._tag === "granted" && probe.reply._tag === "denied" && probeForwardedCalls === 0;

  const serveBound = async (token: string, request: Request, signal: AbortSignal) => {
    signal.throwIfAborted();
    input.assertActive(signal);
    const url = new URL(request.url);
    const reply = await access.serve({
      token,
      provider: "anthropic",
      path: `${url.pathname}${url.search}`,
      request,
    });
    signal.throwIfAborted();
    input.assertActive(signal);
    return reply;
  };

  return {
    async complete(
      request: { readonly poolId: string; readonly model: string; readonly attempt: string },
      signal: AbortSignal,
    ) {
      if (
        request.poolId !== STANDARD_PROOF_MODEL_POOL_ID ||
        request.model !== STANDARD_PROOF_MODEL_ID
      ) {
        throw new Error("Unexpected standard proof status model route");
      }
      const secrets = input.registered() ?? [];
      const token = bind(
        "status",
        request.poolId,
        request.model,
        signal,
        secrets.map((secret) => secret.name),
        request.attempt,
      );
      const reply = await serveBound(
        token,
        new Request("http://standard-proof.invalid/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: request.model,
            messages: [{ role: "user", content: secrets.map((secret) => secret.value).join(" ") }],
          }),
        }),
        signal,
      );
      if (reply._tag !== "granted" || reply.reply._tag !== "forwarded") {
        throw new Error("Standard proof status request was denied by ModelAccess");
      }
      const note: unknown = await reply.reply.response.json();
      if (
        note === null ||
        typeof note !== "object" ||
        !("nextStep" in note) ||
        typeof note.nextStep !== "string" ||
        !("progress" in note) ||
        typeof note.progress !== "string"
      )
        throw new Error("Standard proof model returned an invalid status note");
      return { nextStep: note.nextStep, progress: note.progress };
    },
    async serve(request: Request, signal = new AbortController().signal) {
      const active = input.authority.activeAttempt();
      if (active === null) throw new Error("Standard proof has no active Claude attempt");
      const secrets = input.registered() ?? [];
      const body = await request.clone().text();
      const placeholderNames = secrets
        .filter((secret) => secret.value.length > 0 && body.includes(secret.value))
        .map((secret) => secret.name);
      const token = bind(
        "native",
        STANDARD_PROOF_MODEL_POOL_ID,
        await modelIn(request),
        signal,
        placeholderNames,
      );
      const reply = await serveBound(token, request, signal);
      if (reply._tag === "granted" && reply.reply._tag === "forwarded") return reply.reply.response;
      if (reply._tag === "granted" && reply.reply._tag === "failed") {
        return new Response(reply.reply.reason, { status: 502 });
      }
      const reason =
        reply._tag === "denied"
          ? reply.reason
          : reply.reply._tag === "forwarded"
            ? "Unexpected local model route"
            : reply.reply.reason;
      return new Response(reason, { status: 403 });
    },
    inspect() {
      const evidence = [...statusForwards, ...nativeForwards];
      return {
        kind: "real-model-access-with-test-authority-and-test-pool-adapter",
        modelAccess: "makeModelAccess + Effect.runPromise",
        authority: "TEST AUTHORITY",
        poolAdapter: "TEST POOL ADAPTER",
        unregisteredProbe: {
          attempted: true,
          denied: probeDenied,
          forwardedCalls: probeForwardedCalls,
        },
        authorizationCount,
        statusForwardCount: statusForwards.length,
        nativeForwardCount: nativeForwards.length,
        statusForwards: [...statusForwards],
        nativeForwards: [...nativeForwards],
        ok: probeDenied && evidence.every((item) => item.scrubbed),
      };
    },
  };
}
