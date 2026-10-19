import { makeSecretScrubber, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import type { ComputerExecPort } from "../../src/computer/Computer.ts";
import { createStandardHarnessHookCallback } from "../../src/hooks/StandardHarnessHooks.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type { KernelCommandChild } from "../../src/kernel/KernelCommandForwarder.ts";
import { createHookSecretBoundary } from "../../src/models/HookSecrets.ts";
import { createStandardProofState, STANDARD_PROOF_STATUS_NOTE } from "./standardProofState.ts";
import { createStandardProofModelGateway } from "./standardProofModelGateway.ts";

// Public fixture values have no account or service behind them.
export const STANDARD_PROOF_NAMED_SECRET = {
  name: "API_TOKEN",
  value: "N".repeat("{{secret:API_TOKEN}}".length),
};
export const STANDARD_PROOF_VAULT_SECRET = {
  name: "VAULT_TOKEN",
  value: "V".repeat("{{op://proof/item/password}}".length),
};
export const STANDARD_PROOF_WRITE =
  "official write: {{secret:API_TOKEN}} {{op://proof/item/password}}\n";
export const STANDARD_PROOF_FILLED_WRITE = `official write: ${STANDARD_PROOF_NAMED_SECRET.value} ${STANDARD_PROOF_VAULT_SECRET.value}\n`;
export const STANDARD_PROOF_ENV = Object.freeze({
  PROOF_API_TOKEN: "{{secret:API_TOKEN}}",
  PROOF_VAULT_TOKEN: "{{op://proof/item/password}}",
});

/** Test adapters for the restart ports; all writes and child processes remain real kernel operations. */
export function createStandardProofAdapter(
  storage: FacetStorage,
  scope: string,
  forward: (request: Request) => Promise<Response> = async () => {
    throw new Error("This standard proof has no native model HTTP transport");
  },
) {
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
  let writes = 0;
  let commandEnvironments = 0;
  let before = 0;
  let after = 0;
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

  return {
    callback,
    prepare: () => modelGatewayReady.then(() => undefined),
    serve: async (request: Request) => (await modelGatewayReady).serve(request, lifetime.signal),
    signal: lifetime.signal,
    async write(text: string, operation: (filled: string) => Promise<void>) {
      if (before === 0) throw new Error("A secret write preceded the official PreToolUse hook");
      await secrets.useWrite(
        text,
        async (filled, signal) => {
          state.assertActive(signal);
          await operation(filled);
          writes += 1;
          return "";
        },
        lifetime.signal,
      );
    },
    commands(computer: ComputerExecPort): ComputerExecPort {
      return {
        async exec(command, signal) {
          let child: KernelCommandChild | undefined;
          try {
            await secrets.useEnvironment(
              STANDARD_PROOF_ENV,
              async (filled, current) => {
                state.assertActive(current);
                child = await computer.exec(
                  { ...command, env: { ...command.env, ...filled } },
                  current,
                );
                commandEnvironments += 1;
                return "";
              },
              signal,
            );
            if (!child) throw new Error("Proof command did not start");
            return {
              ...child,
              stdout: child.stdout.pipeThrough(scrubber().bytes()),
              stderr: child.stderr.pipeThrough(scrubber().bytes()),
            };
          } catch (error) {
            await child?.dispose();
            throw error;
          }
        },
      };
    },
    scrub: (text: string) => scrubber().text(text),
    close() {
      lifetime.abort(new Error("Standard hook proof ended"));
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
          writes,
          commandEnvironments,
          modelWireScrubber: "existing Gateway implementation remains authoritative",
        },
        ok:
          thread.ok &&
          ready &&
          before > 0 &&
          after === before &&
          commandEnvironments > 0 &&
          model?.ok === true &&
          model.statusForwardCount === 1,
      };
    },
  };
}

export type StandardProofAdapter = ReturnType<typeof createStandardProofAdapter>;
