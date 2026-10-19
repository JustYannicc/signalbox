import type { HarnessRunStoreCommand, State } from "./schemas.ts";
import { fail, same } from "./errors.ts";
import type { Decision } from "./records.ts";
import { isRequestCommand, transitionRequests } from "./requestTransition.ts";
import { legacyVersion } from "./format.ts";

const decision = (state: State, changed = true): Decision => ({
  state,
  action: changed ? "recorded" : "unchanged",
});

export function transition(state: State | null, command: HarnessRunStoreCommand): Decision {
  if (command.type === "initialize") {
    if (state) {
      const first = state.claims[0];
      if (
        !same(state.seed, command.seed) ||
        state.controlKey !== command.controlKey ||
        first?.supervisorKey !== command.supervisorKey ||
        first?.claimId !== command.claimId ||
        first.requestId !== command.requestId
      )
        return fail("CONFLICT");
      return decision(state, false);
    }
    if (command.controlKey === command.supervisorKey) return fail("CONFLICT");
    return decision({
      version: legacyVersion,
      seed: command.seed,
      controlKey: command.controlKey,
      claims: [
        {
          epoch: 1,
          expectedEpoch: 0,
          claimId: command.claimId,
          requestId: command.requestId,
          supervisorKey: command.supervisorKey,
        },
      ],
      invocation: null,
      progress: null,
      terminal: null,
      receipts: [],
      intents: [],
    });
  }
  if (!state) return fail("MISSING");
  const supervisor = state.claims.at(-1);
  if (!supervisor) return fail("CORRUPT");
  if (command.type === "read") return decision(state, false);
  if (command.type === "takeover") {
    if (command.controlKey !== state.controlKey) return fail("STALE_SUPERVISOR");
    const previous = state.claims.find((claim) => claim.requestId === command.requestId);
    if (previous) {
      if (
        previous.claimId !== command.claimId ||
        previous.expectedEpoch !== command.expectedEpoch ||
        previous.supervisorKey !== command.supervisorKey
      )
        return fail("CONFLICT");
      if (previous.epoch !== supervisor.epoch) return fail("STALE_SUPERVISOR");
      return decision(state, false);
    }
    if (command.expectedEpoch !== supervisor.epoch) return fail("STALE_SUPERVISOR");
    if (state.claims.some((claim) => claim.claimId === command.claimId)) return fail("CONFLICT");
    if (
      command.supervisorKey === state.controlKey ||
      command.supervisorKey === state.invocation?.publisherKey ||
      state.requests?.facets.some((facet) => facet.publisherKey === command.supervisorKey) ||
      state.claims.some((claim) => claim.supervisorKey === command.supervisorKey)
    )
      return fail("CONFLICT");
    if (state.claims.length >= 64) return fail("LIMIT");
    return decision({
      ...state,
      claims: [
        ...state.claims,
        {
          epoch: supervisor.epoch + 1,
          expectedEpoch: command.expectedEpoch,
          claimId: command.claimId,
          requestId: command.requestId,
          supervisorKey: command.supervisorKey,
        },
      ],
    });
  }
  if ("supervisor" in command) {
    if (
      command.supervisor.supervisorKey !== supervisor.supervisorKey ||
      command.supervisor.epoch !== supervisor.epoch ||
      command.supervisor.claimId !== supervisor.claimId
    )
      return fail("STALE_SUPERVISOR");
  }
  if (isRequestCommand(command)) return transitionRequests(state, command);
  if (
    state.requests &&
    ("publisher" in command || command.type === "declare" || command.type === "retirePublisher")
  )
    return fail("CONFLICT");
  if ("supervisor" in command) {
    switch (command.type) {
      case "declare": {
        if (
          command.publisherKey === state.controlKey ||
          state.claims.some((claim) => claim.supervisorKey === command.publisherKey)
        )
          return fail("CONFLICT");
        if (state.invocation) {
          if (
            !same(state.invocation.declaration, command.declaration) ||
            state.invocation.publisherKey !== command.publisherKey
          )
            return fail("CONFLICT");
          return { state, action: "observe-only" };
        }
        // A lost response consumes the launch right. Retrying can only inspect the declared call.
        return {
          state: {
            ...state,
            invocation: {
              declaration: command.declaration,
              publisherKey: command.publisherKey,
              declaredEpoch: supervisor.epoch,
              retired: false,
            },
          },
          action: "launch-once",
        };
      }
      case "receipt": {
        const previous = state.receipts.find(
          (receipt) => receipt.receiptId === command.receipt.receiptId,
        );
        if (previous) {
          if (!same(previous, { ...command.receipt, epoch: previous.epoch }))
            return fail("CONFLICT");
          return decision(state, false);
        }
        if (state.receipts.length >= 64) return fail("LIMIT");
        return decision({
          ...state,
          receipts: [...state.receipts, { ...command.receipt, epoch: supervisor.epoch }],
        });
      }
      case "intent": {
        const intent = { ...command.intent, epoch: supervisor.epoch, claimId: supervisor.claimId };
        const previous = state.intents.find((entry) => entry.intentId === intent.intentId);
        if (previous) {
          if (!same(previous, intent)) return fail("CONFLICT");
          return decision(state, false);
        }
        if (state.intents.length >= 64) return fail("LIMIT");
        return decision({ ...state, intents: [...state.intents, intent] });
      }
      case "retirePublisher":
        if (!state.invocation || !state.terminal) return fail("CONFLICT");
        return state.invocation.retired
          ? decision(state, false)
          : decision({ ...state, invocation: { ...state.invocation, retired: true } });
    }
  }
  if ("publisher" in command) {
    const invocation = state.invocation;
    if (
      !invocation ||
      invocation.retired ||
      command.publisher.invocationId !== invocation.declaration.invocationId ||
      command.publisher.nativeIncarnationId !== invocation.declaration.nativeIncarnationId ||
      command.publisher.publisherKey !== invocation.publisherKey
    )
      return fail("PUBLISHER_DENIED");
    if (command.type === "progress") {
      if (state.terminal) return fail("TERMINAL");
      if (state.progress?.sequence === command.progress.sequence) {
        if (!same(state.progress, command.progress)) return fail("CONFLICT");
        return decision(state, false);
      }
      if (command.progress.sequence !== (state.progress?.sequence ?? 0) + 1)
        return fail("OUT_OF_ORDER");
      return decision({ ...state, progress: command.progress });
    }
    if (state.terminal) {
      if (!same(state.terminal, command.terminal)) return fail("CONFLICT");
      return decision(state, false);
    }
    if (command.terminal.sequence !== (state.progress?.sequence ?? 0) + 1)
      return fail("OUT_OF_ORDER");
    return decision({ ...state, terminal: command.terminal });
  }
  return fail("INVALID");
}
