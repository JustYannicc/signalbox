import { recoverModelPhysicalIncarnation } from "../modelPhysicalRecovery.fixture.ts";
import { decodeModelCommandOutput } from "./modelCommandOutput.mjs";
import { createCombinedCodexModelSocket } from "./modelSocket.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const STARTUP_RESPONSE_ID = "resp-sb1070-combined-r4-startup-empty-01";
import { EXPECTATIONS } from "./modelExpectations.mjs";
export { EXPECTATIONS } from "./modelExpectations.mjs";

const turnsByNumber = new Map(EXPECTATIONS.turns.map((turn) => [turn.turn, turn]));
const allCallIds = new Set(
  EXPECTATIONS.turns.flatMap((turn) =>
    turn.actions.filter((action) => action.callId).map((action) => action.callId),
  ),
);
const allResponseIds = new Set([
  `${STARTUP_RESPONSE_ID}-1`,
  `${STARTUP_RESPONSE_ID}-2`,
  ...EXPECTATIONS.turns.flatMap((turn) => turn.actions.map((action) => action.responseId)),
]);
const allMessageIds = new Set(EXPECTATIONS.turns.map((turn) => turn.actions.at(-1).messageId));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNever(condition, message) {
  if (!condition) throw new Error(message);
}

function latestUserText(input) {
  const users = input.filter((item) => isRecord(item) && item.role === "user");
  if (users.length === 0) return undefined;
  const content = users.at(-1).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((part) =>
    isRecord(part) && typeof part.text === "string" ? part.text : undefined,
  );
  return parts.some((part) => part === undefined) ? undefined : parts.join("");
}

function promptOccurrences(input, prompt) {
  return input.filter(
    (item) => isRecord(item) && item.role === "user" && latestUserText([item]) === prompt,
  ).length;
}

function exposesTool(tools, name) {
  const pending = Array.isArray(tools) ? [...tools] : [];
  while (pending.length > 0) {
    const tool = pending.pop();
    if (!isRecord(tool)) continue;
    if (tool.name === name) return true;
    if (Array.isArray(tool.tools)) pending.push(...tool.tools);
  }
  return false;
}

function outputText(item, description) {
  if (typeof item.output === "string") return item.output;
  if (
    Array.isArray(item.output) &&
    item.output.length === 1 &&
    item.output[0]?.type === "input_text" &&
    typeof item.output[0].text === "string"
  ) {
    return item.output[0].text;
  }
  throw new Error(`${description} output must be a string or one input_text item`);
}

function assertNoToolError(item, description) {
  for (const key of ["is_error", "isError"]) {
    if (Object.hasOwn(item, key) && item[key] !== false)
      throw new Error(`${description} reported ${key}=${String(item[key])}`);
  }
  if (
    Object.hasOwn(item, "error") &&
    item.error !== undefined &&
    item.error !== null &&
    item.error !== false
  ) {
    throw new Error(`${description} included an error payload`);
  }
}

function matchingCurrentResults(input, turn) {
  const callIds = new Set(
    turn.actions.filter((action) => action.callId).map((action) => action.callId),
  );
  return input.filter(
    (item) =>
      isRecord(item) &&
      callIds.has(item.call_id) &&
      typeof item.type === "string" &&
      item.type.endsWith("_output"),
  );
}

function expectedPriorToolActions(turn, actionIndex) {
  return turn.actions.slice(0, actionIndex).filter((action) => action.callId);
}

function itemForAction(action) {
  if (action.kind === "exec_command") {
    return {
      type: "function_call",
      call_id: action.callId,
      name: "exec_command",
      arguments: action.argumentsJson,
    };
  }
  if (action.kind === "apply_patch") {
    return {
      type: "custom_tool_call",
      call_id: action.callId,
      name: "apply_patch",
      input: action.input,
    };
  }
  if (action.kind === "assistant_final") {
    return {
      type: "message",
      id: action.messageId,
      role: "assistant",
      content: [{ type: "output_text", text: action.text }],
    };
  }
  throw new Error(`Unsupported frozen model action ${action.kind}`);
}

function responseCompleted(responseId) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function responseSse(responseId, item) {
  const events = [
    { type: "response.created", response: { id: responseId } },
    ...(item === undefined ? [] : [{ type: "response.output_item.done", item }]),
    responseCompleted(responseId),
  ];
  const rawResponse = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return { rawResponse, events };
}

async function sha256Hex(raw) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle?.digest)
    throw new Error("Web Crypto SHA-256 is required for model evidence receipts");
  const digest = await cryptoApi.subtle.digest("SHA-256", encoder.encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Session, turn, and socket transitions share an owner so recovery drains before rebinding.
export function createCombinedCodexModelPeer({
  WebSocketPair,
  persistModelRecord,
  verifyNativeTerminal,
  verifyReplacement,
  verifyPhysicalRecovery,
} = {}) {
  if (typeof persistModelRecord !== "function")
    throw new TypeError("persistModelRecord is required for the root durable ledger");
  if (typeof verifyNativeTerminal !== "function")
    throw new TypeError("verifyNativeTerminal is required for root native-event receipts");
  if (typeof verifyReplacement !== "function")
    throw new TypeError("verifyReplacement is required for root stop/join receipts");

  const records = [];
  const validatedToolResults = [];
  const completedTurnReceipts = [];
  const usedCallIds = new Set();
  const usedResponseIds = new Set();
  const chunkIds = new Set();
  const seenResultCallIds = new Set();
  let sessionId;
  let activeTurn;
  let completedTurn = 0;
  let currentIncarnation;
  let preparedIncarnation;
  const preparedOrdinals = new Map();
  const promptStartedIncarnations = new Set();
  let replacementCount = 0;
  let expectedReplacement;
  let logicalPreparations = 0;
  let recovering = false;
  const logicalIncarnations = new Map();
  const physicalRecoveries = [];
  let startupCount = 0;
  const startupIncarnations = new Set();
  let recordSequence = 0;
  let modelExchangeSequence = 0;
  let failure;
  let resolveFailure;
  const failurePromise = new Promise((resolve) => {
    resolveFailure = resolve;
  });

  function fail(cause) {
    if (failure === undefined) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
      resolveFailure(failure);
    }
    return failure;
  }

  function requireHealthy() {
    if (failure !== undefined) throw failure;
  }

  function requireSession() {
    if (typeof sessionId !== "string")
      throw new Error("Bind the actual native session UUID before the first model request");
    return sessionId;
  }

  async function persistRecord(record) {
    records.push(record);
    try {
      await persistModelRecord(record);
    } catch (cause) {
      throw fail(cause);
    }
  }

  async function makeReceipt(kind, fields, raw) {
    const bytes = encoder.encode(raw).byteLength;
    const record = Object.freeze({
      schema: "signalbox.1070.combined-codex-r4-model-record/v1",
      sequence: ++recordSequence,
      kind,
      nativeSessionId: sessionId ?? null,
      turn: activeTurn?.turn ?? null,
      incarnation: activeTurn?.incarnation ?? preparedIncarnation ?? null,
      startupPhase: activeTurn
        ? activeTurn.nextActionIndex === 0
          ? "before-first-prompt"
          : null
        : sessionId === undefined
          ? "before-native-session-bind"
          : "before-begin-turn",
      modelExchangeOrdinal: activeTurn?.exchangeOrdinal ?? null,
      ...fields,
      byteLengthUtf8: bytes,
      sha256: await sha256Hex(raw),
      raw,
    });
    await persistRecord(record);
    return record;
  }

  async function onRawRequest({ rawRequestText, socketId, requestOrdinal }) {
    requireHealthy();
    if (recovering) throw new Error("Physical model recovery has not drained its prior sockets");
    if (preparedIncarnation === undefined)
      throw new Error("prepareIncarnation must precede model socket traffic");
    modelExchangeSequence++;
    if (activeTurn) activeTurn.exchangeOrdinal++;
    const lifecycle =
      activeTurn?.modelFinalSent === true
        ? "request-after-final-before-native-terminal"
        : activeTurn
          ? "turn-active"
          : sessionId === undefined
            ? "startup-before-native-session-bind"
            : "startup-before-begin-turn";
    const exchangeRecord = await makeReceipt(
      "model_request",
      {
        modelExchangeSequence,
        socketId,
        socketRequestOrdinal: requestOrdinal,
        lifecycle,
      },
      rawRequestText,
    );
    return Object.freeze({
      modelExchangeSequence,
      modelRequestSequence: exchangeRecord.sequence,
      nativeSessionId: exchangeRecord.nativeSessionId,
      turn: activeTurn?.turn ?? null,
      incarnation: activeTurn?.incarnation ?? preparedIncarnation,
      modelExchangeOrdinal: activeTurn?.exchangeOrdinal ?? null,
      lifecycle,
      startupPhase: exchangeRecord.startupPhase,
    });
  }

  function assertCurrentResultShape(input, turn, actionIndex) {
    const expectedActions = expectedPriorToolActions(turn, actionIndex);
    const historyIds = new Set(
      EXPECTATIONS.turns
        .filter((entry) => entry.turn < turn.turn)
        .flatMap((entry) =>
          entry.actions.filter((action) => action.callId).map((action) => action.callId),
        ),
    );
    for (const item of input) {
      if (!isRecord(item) || typeof item.type !== "string" || !item.type.endsWith("_output"))
        continue;
      if (!allCallIds.has(item.call_id))
        throw new Error(`Unlisted model tool result ${String(item.call_id)}`);
      if (historyIds.has(item.call_id) && !seenResultCallIds.has(item.call_id))
        throw new Error("Unverified prior-turn tool result appeared as history");
      if (
        !historyIds.has(item.call_id) &&
        !turn.actions.some((action) => action.callId === item.call_id)
      )
        throw new Error("A future-turn tool result appeared before its dispatch");
    }
    for (const action of expectedActions) {
      const calls = input.filter(
        (item) =>
          isRecord(item) &&
          item.call_id === action.callId &&
          (item.type === "function_call" || item.type === "custom_tool_call"),
      );
      assertNever(calls.length === 1, `Expected exactly one native echoed call ${action.callId}`);
      const call = calls[0];
      if (action.kind === "exec_command") {
        assertNever(
          call.type === "function_call" &&
            call.name === "exec_command" &&
            call.arguments === action.argumentsJson,
          `Native command arguments changed for ${action.callId}`,
        );
      } else {
        assertNever(
          call.type === "custom_tool_call" &&
            call.name === "apply_patch" &&
            call.input === action.input,
          `Native patch input changed for ${action.callId}`,
        );
      }
    }
    const actual = matchingCurrentResults(input, turn);
    const actualIds = actual.map((item) => item.call_id);
    const expectedIds = expectedActions.map((action) => action.callId);
    assertNever(
      JSON.stringify(actualIds) === JSON.stringify(expectedIds),
      `Turn ${turn.turn} tool results are missing, extra, duplicated, or out of order: got ${JSON.stringify(actualIds)}, expected ${JSON.stringify(expectedIds)}`,
    );
    for (let index = 0; index < expectedActions.length; index++) {
      const action = expectedActions[index];
      const item = actual[index];
      const expectedType =
        action.kind === "exec_command" ? "function_call_output" : "custom_tool_call_output";
      assertNever(
        item.type === expectedType,
        `Turn ${turn.turn} result ${action.callId} had type ${item.type}, expected ${expectedType}`,
      );
      assertNoToolError(item, `${action.kind} ${action.callId}`);
      if (action.kind === "exec_command") {
        const decoded = decodeModelCommandOutput({ input }, action.callId);
        assertNever(
          decoded.status === "completed" && decoded.exitCode === 0,
          `Turn ${turn.turn} command ${action.callId} failed with exit code ${decoded.exitCode}`,
        );
        assertNever(
          decoded.output === action.expectedOutput,
          `Turn ${turn.turn} command ${action.callId} returned unexpected output ${JSON.stringify(decoded.output)}`,
        );
        assertNever(
          typeof decoded.chunkId === "string" && decoded.chunkId.length > 0,
          `Turn ${turn.turn} command ${action.callId} had an empty Chunk ID`,
        );
        if (seenResultCallIds.has(action.callId)) {
          const prior = validatedToolResults.find((result) => result.callId === action.callId);
          assertNever(
            prior !== undefined &&
              prior.chunkId === decoded.chunkId &&
              prior.wallTimeSeconds === decoded.wallTimeSeconds &&
              prior.originalTokenCount === decoded.originalTokenCount,
            `Turn ${turn.turn} command result ${action.callId} changed in restored history`,
          );
        } else {
          assertNever(
            !chunkIds.has(decoded.chunkId),
            `Turn ${turn.turn} command ${action.callId} reused Chunk ID ${decoded.chunkId}`,
          );
          chunkIds.add(decoded.chunkId);
          validatedToolResults.push({
            turn: turn.turn,
            callId: action.callId,
            toolName: "exec_command",
            status: decoded.status,
            exitCode: decoded.exitCode,
            output: decoded.output,
            chunkId: decoded.chunkId,
            wallTimeSeconds: decoded.wallTimeSeconds,
            originalTokenCount: decoded.originalTokenCount,
            errorFlag: false,
          });
        }
      } else {
        if (item.name !== undefined && item.name !== "apply_patch")
          throw new Error(`Turn ${turn.turn} patch result had unexpected name ${item.name}`);
        const text = outputText(item, `apply_patch ${action.callId}`);
        const match = /^Exit code: 0\nWall time: (\d+(?:\.\d+)?) seconds\nOutput:\n([\s\S]*)$/.exec(
          text,
        );
        assertNever(
          match !== null && Number.isFinite(Number(match[1])) && match[2] === action.expectedOutput,
          `Turn ${turn.turn} apply_patch ${action.callId} returned unexpected output ${JSON.stringify(text)}`,
        );
        if (!seenResultCallIds.has(action.callId))
          validatedToolResults.push({
            turn: turn.turn,
            callId: action.callId,
            toolName: "apply_patch",
            status: "completed",
            exitCode: 0,
            output: match[2],
            wallTimeSeconds: Number(match[1]),
            rawEnvelope: text,
            errorFlag: false,
          });
      }
    }
  }

  async function persistValidatedResults(input, turn, actionIndex, requestReceipt) {
    const expectedActions = expectedPriorToolActions(turn, actionIndex);
    if (expectedActions.length === 0) return;
    const actual = matchingCurrentResults(input, turn);
    for (let index = 0; index < expectedActions.length; index++) {
      const action = expectedActions[index];
      const rawItem = JSON.stringify(actual[index]);
      const bytes = encoder.encode(rawItem).byteLength;
      if (seenResultCallIds.has(action.callId)) continue;
      const record = Object.freeze({
        schema: "signalbox.1070.combined-codex-r4-model-record/v1",
        sequence: ++recordSequence,
        kind: "validated_tool_result",
        nativeSessionId: sessionId,
        turn: turn.turn,
        incarnation: activeTurn.incarnation,
        modelExchangeOrdinal: requestReceipt.modelExchangeOrdinal,
        modelExchangeSequence: requestReceipt.modelExchangeSequence,
        callId: action.callId,
        toolName: action.kind,
        byteLengthUtf8: bytes,
        sha256: await sha256Hex(rawItem),
        raw: rawItem,
      });
      await persistRecord(record);
      seenResultCallIds.add(action.callId);
    }
  }

  function assertLatestPrompt(effectiveRequest, turn) {
    assertNever(
      Array.isArray(effectiveRequest.input),
      `Turn ${turn.turn} request input is missing`,
    );
    assertNever(
      latestUserText(effectiveRequest.input) === turn.prompt,
      `Turn ${turn.turn} latest user prompt did not exactly match beginTurn`,
    );
    assertNever(
      promptOccurrences(effectiveRequest.input, turn.prompt) === 1,
      `Turn ${turn.turn} accepted prompt appeared more than once`,
    );
  }

  function assertUniqueOutputIds(action) {
    if (action.callId) {
      assertNever(
        allCallIds.has(action.callId),
        `Turn emitted an unlisted call ID ${action.callId}`,
      );
      assertNever(!usedCallIds.has(action.callId), `Duplicate model tool call ID ${action.callId}`);
      usedCallIds.add(action.callId);
    }
    assertNever(
      allResponseIds.has(action.responseId),
      `Emitted an unlisted response ID ${action.responseId}`,
    );
    assertNever(
      !usedResponseIds.has(action.responseId),
      `Duplicate model response ID ${action.responseId}`,
    );
    usedResponseIds.add(action.responseId);
    if (action.messageId)
      assertNever(
        allMessageIds.has(action.messageId),
        `Emitted an unlisted assistant message ID ${action.messageId}`,
      );
  }

  async function respond({
    requestReceipt,
    rawRequestText: _rawRequestText,
    request,
    effectiveRequest,
  }) {
    try {
      requireHealthy();
      assertNever(
        isRecord(request) && Array.isArray(request.input),
        "Codex Responses request must contain an input array",
      );
      const isEmptyStartup = request.input.length === 0 && effectiveRequest.input.length === 0;
      const metadata = request.client_metadata;
      let turnMetadata;
      if (typeof metadata?.["x-codex-turn-metadata"] === "string") {
        try {
          turnMetadata = JSON.parse(metadata["x-codex-turn-metadata"]);
        } catch {}
      }
      const isContextPrewarm =
        request.generate === false &&
        typeof sessionId === "string" &&
        metadata?.session_id === sessionId &&
        metadata?.thread_id === sessionId &&
        metadata?.turn_id === "" &&
        turnMetadata?.request_kind === "prewarm" &&
        turnMetadata?.session_id === sessionId &&
        turnMetadata?.thread_id === sessionId &&
        turnMetadata?.turn_id === "" &&
        (activeTurn === undefined || latestUserText(effectiveRequest.input) !== activeTurn.prompt);
      if (isEmptyStartup || isContextPrewarm) {
        const ordinal = preparedOrdinals.get(preparedIncarnation);
        if (
          preparedIncarnation === undefined ||
          !Number.isSafeInteger(ordinal) ||
          (activeTurn && activeTurn.incarnation !== preparedIncarnation) ||
          promptStartedIncarnations.has(preparedIncarnation) ||
          startupIncarnations.has(preparedIncarnation) ||
          request.generate === true ||
          request.previous_response_id != null
        ) {
          throw new Error("Unexpected or extra empty-input startup request");
        }
        startupCount++;
        startupIncarnations.add(preparedIncarnation);
        const startupResponseId = `${STARTUP_RESPONSE_ID}-${ordinal}`;
        const { rawResponse, events } = responseSse(startupResponseId);
        const responseRecord = await makeReceipt(
          "model_response",
          {
            modelExchangeSequence: requestReceipt.modelExchangeSequence,
            modelRequestSequence: requestReceipt.modelRequestSequence,
            nativeSessionId: requestReceipt.nativeSessionId,
            turn: requestReceipt.turn,
            startup: true,
            startupPhase: requestReceipt.lifecycle,
            incarnation: preparedIncarnation,
            responseId: startupResponseId,
            responseEvents: events.map((event) => event.type),
            outputCallIds: [],
          },
          rawResponse,
        );
        assertNever(
          events.filter((event) => event.type === "response.completed").length === 1,
          "Startup response must have exactly one terminal event",
        );
        assertNever(
          responseRecord.sequence > requestReceipt.modelRequestSequence,
          "Startup response receipt sequence did not follow its request",
        );
        return rawResponse;
      }

      requireSession();
      if (!activeTurn) throw new Error("Nonempty model request arrived before root beginTurn");
      if (activeTurn.modelFinalSent)
        throw new Error(
          `Turn ${activeTurn.turn} received an extra Responses request after its final output`,
        );
      if (activeTurn.incarnation !== preparedIncarnation)
        throw new Error("Model turn is not owned by the prepared incarnation");
      const turn = turnsByNumber.get(activeTurn.turn);
      assertLatestPrompt(effectiveRequest, turn);
      promptStartedIncarnations.add(preparedIncarnation);
      const actionIndex = activeTurn.nextActionIndex;
      assertNever(
        actionIndex < turn.actions.length,
        `Turn ${turn.turn} has no remaining expected response`,
      );
      assertCurrentResultShape(effectiveRequest.input, turn, actionIndex);
      await persistValidatedResults(effectiveRequest.input, turn, actionIndex, requestReceipt);

      const action = turn.actions[actionIndex];
      if (action.kind === "exec_command" && !exposesTool(request.tools, "exec_command")) {
        throw new Error(`Turn ${turn.turn} model request did not expose native exec_command`);
      }
      if (action.kind === "apply_patch" && !exposesTool(request.tools, "apply_patch")) {
        throw new Error(`Turn ${turn.turn} model request did not expose native apply_patch`);
      }
      assertUniqueOutputIds(action);
      const item = itemForAction(action);
      const { rawResponse, events } = responseSse(action.responseId, item);
      assertNever(
        events.filter((event) => event.type === "response.completed").length === 1,
        `Turn ${turn.turn} response must have exactly one terminal event`,
      );
      assertNever(
        events.filter((event) => event.type === "response.output_item.done").length === 1,
        `Turn ${turn.turn} response must emit exactly one frozen output item`,
      );
      const outputCallIds = action.callId ? [action.callId] : [];
      await makeReceipt(
        "model_response",
        {
          modelExchangeSequence: requestReceipt.modelExchangeSequence,
          modelRequestSequence: requestReceipt.modelRequestSequence,
          turn: turn.turn,
          incarnation: activeTurn.incarnation,
          modelExchangeOrdinal: requestReceipt.modelExchangeOrdinal,
          responseId: action.responseId,
          outputItemType: item.type,
          outputCallIds,
          outputMessageId: action.messageId ?? null,
          responseEvents: events.map((event) => event.type),
          actionIndex,
        },
        rawResponse,
      );

      activeTurn.nextActionIndex++;
      if (action.kind === "assistant_final") activeTurn.modelFinalSent = true;
      return rawResponse;
    } catch (cause) {
      throw fail(cause);
    }
  }

  const modelSocket = createCombinedCodexModelSocket({
    WebSocketPair,
    ownerForSocket: () => preparedIncarnation,
    onRawRequest,
    respond,
    onRawResponseFrame: (frame, requestReceipt) =>
      makeReceipt(
        "model_response_frame",
        {
          modelExchangeSequence: requestReceipt.modelExchangeSequence,
          modelRequestSequence: requestReceipt.modelRequestSequence,
          nativeSessionId: requestReceipt.nativeSessionId,
          turn: requestReceipt.turn,
          incarnation: requestReceipt.incarnation,
          startupPhase: requestReceipt.startupPhase,
          frameSequence: frame.sequence,
          socketId: frame.socketId,
          eventType: frame.eventType,
        },
        frame.raw,
      ),
    onFailure(cause) {
      fail(cause);
    },
  });

  function prepareIncarnation(incarnation) {
    requireHealthy();
    if (typeof incarnation !== "string" || incarnation.length === 0)
      throw new Error("prepareIncarnation requires the root-captured process identity");
    if (recovering || activeTurn)
      throw new Error("Cannot prepare a logical incarnation during an active turn or recovery");
    if (preparedIncarnation !== undefined) throw new Error("An incarnation is already prepared");
    if (completedTurn === 0 && replacementCount === 0 && currentIncarnation === undefined) {
      currentIncarnation = incarnation;
    } else if (
      completedTurn !== 1 ||
      replacementCount !== 1 ||
      currentIncarnation !== incarnation
    ) {
      throw new Error(
        "Only the original incarnation and the sole verified replacement may be prepared",
      );
    }
    const ordinal = preparedOrdinals.size + 1;
    if (logicalPreparations >= 2 || preparedOrdinals.has(incarnation))
      throw new Error("Unexpected logical process incarnation preparation");
    logicalPreparations++;
    logicalIncarnations.set(incarnation, replacementCount);
    preparedOrdinals.set(incarnation, ordinal);
    preparedIncarnation = incarnation;
    return Object.freeze({ incarnation, ordinal });
  }

  async function recoverIncarnation({
    fromIncarnation,
    toIncarnation,
    nativeSessionId,
    checkpoint,
    receipt,
  } = {}) {
    requireHealthy();
    requireSession();
    if (recovering || typeof verifyPhysicalRecovery !== "function")
      throw new Error("Physical recovery has no exclusive verifier");
    recovering = true;
    try {
      const recovery = await recoverModelPhysicalIncarnation(
        { fromIncarnation, toIncarnation, nativeSessionId, checkpoint, receipt },
        {
          nativeSessionId: sessionId,
          currentIncarnation,
          preparedIncarnation,
          activeTurnIncarnation: activeTurn?.incarnation,
          logicalReplacementCount: replacementCount,
          physicalOrdinals: preparedOrdinals,
          logicalIncarnations,
        },
        verifyPhysicalRecovery,
        modelSocket.closeIncarnationAndJoin,
      );
      preparedOrdinals.set(toIncarnation, recovery.ordinal);
      logicalIncarnations.set(toIncarnation, recovery.logicalIncarnation);
      currentIncarnation = preparedIncarnation = toIncarnation;
      if (activeTurn) activeTurn.incarnation = toIncarnation;
      physicalRecoveries.push(recovery);
      return recovery;
    } finally {
      recovering = false;
    }
  }

  function bindNativeSession(nativeSessionId) {
    requireHealthy();
    if (preparedIncarnation === undefined)
      throw new Error("prepareIncarnation must precede native session binding");
    if (sessionId !== undefined) throw new Error("Native session UUID can be bound only once");
    if (typeof nativeSessionId !== "string" || !UUID.test(nativeSessionId))
      throw new Error("Root must pass the actual native session UUID");
    sessionId = nativeSessionId;
    return { nativeSessionId };
  }

  function beginTurn({ turn, incarnation, prompt } = {}) {
    requireHealthy();
    requireSession();
    if (recovering) throw new Error("Physical recovery must finish before selecting a turn");
    if (activeTurn) throw new Error(`Turn ${activeTurn.turn} is still active`);
    if (!Number.isSafeInteger(turn) || turn !== completedTurn + 1 || turn < 1 || turn > 3) {
      throw new Error(
        `beginTurn must select the next explicit turn; received ${String(turn)} after ${completedTurn}`,
      );
    }
    if (typeof incarnation !== "string" || incarnation.length === 0)
      throw new Error("beginTurn requires the root-captured process incarnation identity");
    if (preparedIncarnation !== incarnation)
      throw new Error("beginTurn requires the matching prepared incarnation");
    const expected = turnsByNumber.get(turn);
    if (prompt !== expected.prompt)
      throw new Error(`beginTurn(${turn}) prompt did not match the frozen prompt`);
    if (turn === 1) {
      if (replacementCount !== 0 || currentIncarnation !== incarnation)
        throw new Error("Turn 1 must start in the prepared original incarnation");
    } else {
      if (currentIncarnation !== incarnation)
        throw new Error(`Turn ${turn} did not use its expected process incarnation`);
      if (turn === 2 && replacementCount !== 1)
        throw new Error("Turn 2 requires exactly one replacement after completed turn 1");
      if (turn === 3 && (replacementCount !== 1 || completedTurn !== 2))
        throw new Error("Turn 3 must continue in incarnation 2 with no second replacement");
    }
    activeTurn = {
      turn,
      incarnation,
      prompt,
      nextActionIndex: 0,
      exchangeOrdinal: 0,
      modelFinalSent: false,
      acceptedResultCallIds: [],
    };
    return Object.freeze({ turn, incarnation, prompt });
  }

  async function completeNativeTurn({ turn, receipt } = {}) {
    requireHealthy();
    requireSession();
    if (!activeTurn || turn !== activeTurn.turn)
      throw new Error(`No active turn ${String(turn)} to complete`);
    if (
      activeTurn.modelFinalSent !== true ||
      activeTurn.nextActionIndex !== turnsByNumber.get(turn).actions.length
    ) {
      throw new Error(`Turn ${turn} cannot complete before the fixed assistant final output`);
    }
    if (receipt === undefined || receipt === null)
      throw new Error("Root must pass the durable native terminal receipt");
    const verification = await verifyNativeTerminal({
      turn,
      nativeSessionId: sessionId,
      incarnation: activeTurn.incarnation,
      expectedFinalText: turnsByNumber.get(turn).finalText,
      receipt,
    });
    if (
      !isRecord(verification) ||
      verification.durable !== true ||
      verification.terminalCount !== 1
    ) {
      throw fail(
        new Error(
          `Root native terminal receipt for turn ${turn} did not prove one durable terminal event`,
        ),
      );
    }
    completedTurnReceipts.push(
      Object.freeze({
        turn,
        incarnation: activeTurn.incarnation,
        logicalIncarnation: logicalIncarnations.get(activeTurn.incarnation),
        verification,
      }),
    );
    completedTurn = turn;
    activeTurn = undefined;
    return Object.freeze({ turn, nativeSessionId: sessionId, terminalCount: 1 });
  }

  async function recordReplacement({
    afterCompletedTurn,
    fromIncarnation,
    toIncarnation,
    nativeSessionId,
    receipt,
  } = {}) {
    requireHealthy();
    requireSession();
    if (recovering || replacementCount !== 0 || completedTurn !== 1 || activeTurn)
      throw new Error("The only replacement is after completed turn 1 and before turn 2");
    if (
      afterCompletedTurn !== 1 ||
      fromIncarnation !== currentIncarnation ||
      typeof toIncarnation !== "string" ||
      toIncarnation.length === 0 ||
      toIncarnation === fromIncarnation
    ) {
      throw new Error(
        "Replacement must move from the turn-1 process to one distinct process incarnation",
      );
    }
    if (nativeSessionId !== sessionId)
      throw new Error("Replacement changed the native session UUID");
    if (receipt === undefined || receipt === null)
      throw new Error("Root must pass the durable stop/join/replacement receipt");
    const modelSocketDrain = await modelSocket.closeIncarnationAndJoin(fromIncarnation);
    const previousPhysicalDrains = physicalRecoveries
      .filter((row) => row.logicalIncarnation === 0)
      .map((row) => row.modelSocketDrain);
    const logicalSocketCount =
      modelSocketDrain.socketCount +
      previousPhysicalDrains.reduce((sum, drain) => sum + drain.socketCount, 0);
    if (
      modelSocketDrain.closedAndJoined !== true ||
      logicalSocketCount < 1 ||
      previousPhysicalDrains.some((drain) => !drain.closedAndJoined)
    )
      throw fail(new Error("Turn-1 model socket owner did not close and join at least one socket"));
    const verification = await verifyReplacement({
      afterCompletedTurn,
      nativeSessionId: sessionId,
      fromIncarnation,
      toIncarnation,
      receipt,
      modelSocketDrain: { ...modelSocketDrain, logicalSocketCount, previousPhysicalDrains },
    });
    if (
      !isRecord(verification) ||
      verification.durable !== true ||
      verification.stopConfirmed !== true ||
      verification.joinConfirmed !== true ||
      verification.oldWriterFenced !== true
    ) {
      throw fail(
        new Error(
          "Root replacement receipt did not prove durable stop, join and old-writer fencing",
        ),
      );
    }
    replacementCount++;
    currentIncarnation = toIncarnation;
    preparedIncarnation = undefined;
    expectedReplacement = Object.freeze({
      afterCompletedTurn,
      fromIncarnation,
      toIncarnation,
      nativeSessionId: sessionId,
      modelSocketDrain,
      verification,
    });
    return expectedReplacement;
  }

  function assertComplete() {
    requireHealthy();
    requireSession();
    if (recovering) throw new Error("Physical recovery must finish before selecting a turn");
    if (activeTurn) throw new Error(`Turn ${activeTurn.turn} is still active`);
    if (completedTurn !== 3 || completedTurnReceipts.length !== 3)
      throw new Error("Combined model script did not complete exactly turns 1, 2 and 3");
    if (replacementCount !== 1 || expectedReplacement?.afterCompletedTurn !== 1)
      throw new Error("Combined model script did not record exactly one replacement after turn 1");
    if (
      completedTurnReceipts[1].logicalIncarnation !== 1 ||
      completedTurnReceipts[2].logicalIncarnation !== 1
    )
      throw new Error("Turn 3 did not stay in turn 2's logical incarnation");
    const expectedModelActions = EXPECTATIONS.turns.reduce(
      (sum, turn) => sum + turn.actions.length,
      0,
    );
    if (modelExchangeSequence !== expectedModelActions + startupCount)
      throw new Error(
        `Expected ${expectedModelActions} completed-turn model requests plus ${startupCount} bounded startup requests; saw ${modelExchangeSequence}`,
      );
    if (modelSocket.metrics.responseTerminals !== modelExchangeSequence)
      throw new Error("A model request did not receive exactly one Responses terminal event");
    const expectedCalls = EXPECTATIONS.turns.flatMap((turn) =>
      turn.actions.filter((action) => action.callId).map((action) => action.callId),
    );
    assertNever(
      JSON.stringify([...usedCallIds].sort()) === JSON.stringify([...expectedCalls].sort()),
      "Actual model output call IDs did not equal the frozen three-turn set",
    );
    const expectedResults = expectedCalls;
    const actualResults = validatedToolResults.map((result) => result.callId);
    assertNever(
      JSON.stringify(actualResults) === JSON.stringify(expectedResults),
      "Actual new builtin tool results were missing, duplicated or out of order",
    );
    if (usedResponseIds.size !== expectedModelActions)
      throw new Error(
        `Expected ${expectedModelActions} frozen turn response IDs, received ${usedResponseIds.size}`,
      );
    return Object.freeze({
      nativeSessionId: sessionId,
      completedTurns: completedTurn,
      replacements: replacementCount,
      startupRequests: startupCount,
      modelRequests: modelExchangeSequence,
      modelResponseTerminals: modelSocket.metrics.responseTerminals,
      toolCalls: usedCallIds.size,
      toolResults: validatedToolResults.length,
      modelRecordCount: records.length,
    });
  }

  function fetch(request) {
    requireHealthy();
    if (recovering)
      throw new Error("Physical model recovery must drain before opening another socket");
    const routed = modelSocket.route({ request });
    return new Response(null, { status: 101, webSocket: routed.webSocket });
  }

  async function closeAndJoin() {
    const drain = await modelSocket.closeAndJoin();
    requireHealthy();
    return drain;
  }

  function snapshot() {
    return Object.freeze({
      state: failure === undefined ? "active" : "failed",
      nativeSessionId: sessionId ?? null,
      preparedIncarnation: preparedIncarnation ?? null,
      logicalIncarnation: logicalIncarnations.get(preparedIncarnation) ?? null,
      physicalIncarnations: [...preparedOrdinals].map(([incarnation, ordinal]) => ({
        incarnation,
        ordinal,
        logicalIncarnation: logicalIncarnations.get(incarnation),
      })),
      physicalRecoveries: physicalRecoveries.map(cloneJson),
      completedTurn,
      replacementCount,
      startupCount,
      modelExchangeSequence,
      records: records.map((record) => cloneJson(record)),
      validatedToolResults: validatedToolResults.map((record) => cloneJson(record)),
      socket: cloneJson(modelSocket.metrics),
      failure: failure?.message ?? null,
    });
  }

  function guard(operation) {
    return (...args) => {
      try {
        const result = operation(...args);
        if (result && typeof result.then === "function") {
          return result.catch((cause) => {
            throw fail(cause);
          });
        }
        return result;
      } catch (cause) {
        throw fail(cause);
      }
    };
  }

  return {
    expectations: EXPECTATIONS,
    failure: failurePromise,
    prepareIncarnation: guard(prepareIncarnation),
    recoverIncarnation: guard(recoverIncarnation),
    bindNativeSession: guard(bindNativeSession),
    beginTurn: guard(beginTurn),
    completeNativeTurn: guard(completeNativeTurn),
    recordReplacement: guard(recordReplacement),
    assertComplete: guard(assertComplete),
    fetch: guard(fetch),
    joinClosed: modelSocket.joinClosed,
    closeIncarnationAndJoin: guard(modelSocket.closeIncarnationAndJoin),
    closeAndJoin: guard(closeAndJoin),
    snapshot,
    get failureError() {
      return failure;
    },
    get activeSockets() {
      return modelSocket.activeSockets;
    },
  };
}

export function expectedResponseIds(physicalIncarnations = 2) {
  if (!Number.isSafeInteger(physicalIncarnations) || physicalIncarnations < 1)
    throw new Error("Physical incarnation count must be positive");
  return [
    ...Array.from(
      { length: physicalIncarnations },
      (_, index) => `${STARTUP_RESPONSE_ID}-${index + 1}`,
    ),
    ...EXPECTATIONS.turns.flatMap((turn) => turn.actions.map((action) => action.responseId)),
  ];
}

export function expectedToolCallIds() {
  return [...allCallIds];
}

export function expectedAssistantMessageIds() {
  return [...allMessageIds];
}
