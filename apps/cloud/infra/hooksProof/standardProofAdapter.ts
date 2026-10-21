import { makeSecretScrubber, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import type { ComputerExecPort } from "../../src/computer/Computer.ts";
import { createStandardHarnessHookCallback } from "../../src/hooks/StandardHarnessHooks.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type { KernelCommandChild } from "../../src/kernel/KernelCommandForwarder.ts";
import { canonicalFileByteSelection } from "../../src/kernel/KernelFileBytes.ts";
import type { KernelProgramFileByteSelector } from "../../src/kernel/KernelProgramHost.ts";
import type { Storage } from "../../src/kernel/storage.ts";
import { createHookSecretBoundary } from "../../src/models/HookSecrets.ts";
import { createStandardProofFiles } from "./standardProofFiles.ts";
import { createStandardProofOutput } from "./standardProofOutput.ts";
import { createStandardProofState, STANDARD_PROOF_STATUS_NOTE } from "./standardProofState.ts";
import { createStandardProofModelGateway } from "./standardProofModelGateway.ts";
import {
  containsGeneratedFixtureValue,
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
} from "./standardProofValues.ts";
export {
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
  standardProofFilledWrite,
} from "./standardProofValues.ts";

export const STANDARD_PROOF_WRITE =
  "official write: {{secret:API_TOKEN}} {{op://proof/item/password}}\n";
export const STANDARD_PROOF_ENV = Object.freeze({
  PROOF_API_TOKEN: "{{secret:API_TOKEN}}",
  PROOF_VAULT_TOKEN: "{{op://proof/item/password}}",
});

export function scrubStandardProofRecord(record: unknown): unknown {
  const scrubber = makeSecretScrubber([STANDARD_PROOF_NAMED_SECRET, STANDARD_PROOF_VAULT_SECRET]);
  let priorValue = false;
  const text = JSON.stringify(record, (key, value: unknown) => {
    priorValue ||= containsGeneratedFixtureValue(scrubber.text(key));
    if (typeof value === "string")
      priorValue ||= containsGeneratedFixtureValue(scrubber.text(value));
    return value;
  });
  if (priorValue)
    return {
      ok: false,
      failure: "A prior fixture value reached the public proof record",
      recordBoundary: { unexpectedRawSecret: true },
    };
  const scrubbed = scrubber.text(text);
  const safe: unknown = JSON.parse(scrubbed);
  if (safe === null || typeof safe !== "object" || Array.isArray(safe)) return safe;
  return {
    ...safe,
    ...(Object.hasOwn(safe, "ok")
      ? { ok: Reflect.get(safe, "ok") === true && text === scrubbed }
      : {}),
    recordBoundary: { unexpectedRawSecret: text !== scrubbed },
  };
}

/** Test adapters for the restart ports; all writes and child processes remain real kernel operations. */
export function createStandardProofAdapter(
  storage: FacetStorage,
  scope: string,
  forward: (request: Request) => Promise<Response> = async () => {
    throw new Error("This standard proof has no native model HTTP transport");
  },
  fileStorage?: Storage,
) {
  const storageDatabase = storage;
  type ModelGateway = Awaited<ReturnType<typeof createStandardProofModelGateway>>;
  let modelGateway: ModelGateway | undefined;
  let modelGatewayReady: Promise<ModelGateway>;
  const state = createStandardProofState(storage, scope, async (request, signal) =>
    (await modelGatewayReady).complete(request, signal),
  );
  const lifetime = new AbortController();
  const registered = new Map<string, SecretValue>();
  let ready = false;
  let registrations = 0;
  let commandEnvironments = 0;
  let before = 0;
  let after = 0;
  const files = new Map<Storage, ReturnType<typeof createStandardProofFiles>>();
  modelGatewayReady = createStandardProofModelGateway({
    authority: state.authority,
    assertActive: state.assertActive,
    registered: () => (ready ? [...registered.values()] : null),
    completeResponse: STANDARD_PROOF_STATUS_NOTE,
    forward,
  }).then((gateway) => {
    modelGateway = gateway;
    return gateway;
  });
  // Setup-only unit fixtures can close before this asynchronous bootstrap settles.
  void modelGatewayReady.catch(() => undefined);
  const scrubber = () => {
    state.assertActive(lifetime.signal);
    if (!ready) throw new Error("Proof gateway secrets are not registered");
    return makeSecretScrubber(registered.values());
  };
  const output = createStandardProofOutput(scrubber);
  const secrets = createHookSecretBoundary({
    assertCurrent: state.assertActive,
    async resolveNamedSecret(name) {
      if (name !== STANDARD_PROOF_NAMED_SECRET.name) throw new Error("Unknown proof secret");
      return STANDARD_PROOF_NAMED_SECRET;
    },
    async fillVault(text) {
      const placeholder = "{{op://proof/item/password}}";
      if (!text.includes(placeholder)) throw new Error("Unknown proof vault reference");
      return {
        text: text.replaceAll(placeholder, STANDARD_PROOF_VAULT_SECRET.value),
        secrets: [STANDARD_PROOF_VAULT_SECRET],
      };
    },
    async register(values, signal) {
      await modelGatewayReady;
      storage.transactionSync(() => {
        state.assertActive(signal);
        for (const value of values) registered.set(value.name, value);
        registrations += 1;
        ready = true;
      });
    },
    scrub: (text) => scrubber().text(text),
  });
  const callback = createStandardHarnessHookCallback(state.authority, {
    thread: state.thread,
    automations: state.automations,
    gateway: {
      async beforeToolUse(context) {
        state.assertCurrent(context);
        await secrets.useEnvironment({}, async () => "", context.signal);
        state.assertCurrent(context);
        before += 1;
      },
      async afterToolUse(context) {
        state.assertCurrent(context);
        const output = JSON.stringify(context.request.payload);
        if (scrubber().text(output) !== output) {
          throw new Error(
            "An official tool result reached its hook with an unmasked fixture secret",
          );
        }
        after += 1;
      },
    },
  });

  const selectFileBytes: KernelProgramFileByteSelector = ({ executable, filesystem, parent }) => {
    if (executable === "/bin/git") return canonicalFileByteSelection;
    if (parent !== undefined) return filesystem.fileBytes;
    if (!["/bin/bash", "/bin/cat", "/bin/rg"].includes(executable)) {
      return canonicalFileByteSelection;
    }
    state.assertActive(lifetime.signal);
    if (!ready || registered.size !== 2) throw new Error("Execution file bindings are not ready");
    if (fileStorage === undefined || filesystem.resolve("/").mount.storage !== fileStorage) {
      throw new Error("Execution files must use the proof persistence owner's storage");
    }
    const storage = fileStorage;
    let boundary = files.get(storage);
    if (!boundary) {
      boundary = createStandardProofFiles({
        database: storageDatabase,
        storage,
        assertActive: () => state.assertActive(lifetime.signal),
        bindings: [
          { placeholder: "{{secret:API_TOKEN}}", value: STANDARD_PROOF_NAMED_SECRET.value },
          { placeholder: "{{op://proof/item/password}}", value: STANDARD_PROOF_VAULT_SECRET.value },
          { placeholder: "{{secret:VAULT_TOKEN}}", value: STANDARD_PROOF_VAULT_SECRET.value },
        ],
      });
      files.set(storage, boundary);
    }
    return boundary.selection;
  };

  return {
    callback,
    async prepare() {
      await modelGatewayReady;
      await secrets.useEnvironment(STANDARD_PROOF_ENV, async () => "", lifetime.signal);
    },
    serve: async (request: Request, provider: "anthropic" | "openai" = "anthropic") =>
      (await modelGatewayReady).serve(request, lifetime.signal, provider),
    selectFileBytes,
    output,
    signal: lifetime.signal,
    commands(computer: ComputerExecPort): ComputerExecPort {
      return {
        async exec(command, signal, requester) {
          let child: KernelCommandChild | undefined;
          try {
            await secrets.useEnvironment(
              STANDARD_PROOF_ENV,
              async (filled, current) => {
                state.assertActive(current);
                child = await computer.exec(
                  { ...command, env: { ...command.env, ...filled } },
                  current,
                  requester,
                );
                commandEnvironments += 1;
                return "";
              },
              signal,
            );
            if (!child) throw new Error("Proof command did not start");
            return {
              ...child,
              stdout: output.stdout(command, child.stdout),
              stderr: output.stderr(child.stderr),
            };
          } catch (error) {
            await child?.dispose();
            throw error;
          }
        },
      };
    },
    scrub: (text: string) => scrubber().text(text),
    scrubRecord: scrubStandardProofRecord,
    close() {
      lifetime.abort(new Error("Standard hook proof ended"));
      output.close();
      state.close();
    },
    inspect() {
      const thread = state.inspect();
      const model = modelGateway?.inspect();
      return {
        ...thread,
        modelGateway: model ?? null,
        gateway: {
          kind: "stateful-test-adapter-with-real-io",
          ready,
          registrations,
          registeredNames: [...registered.keys()].sort(),
          beforeToolUse: before,
          afterToolUse: after,
          commandEnvironments,
          files: [...files.values()].map((boundary) => boundary.inspect()),
          modelWireScrubber: "existing Gateway implementation remains authoritative",
        },
        ok:
          thread.ok &&
          ready &&
          before > 0 &&
          after === before &&
          commandEnvironments > 0 &&
          model?.ok === true &&
          model.statusForwardCount === 1 &&
          model.nativeForwardCount > 0,
      };
    },
  };
}

export type StandardProofAdapter = ReturnType<typeof createStandardProofAdapter>;
