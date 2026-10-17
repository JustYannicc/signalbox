import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import type {
  CollaborationInput,
  CollaborationMethod,
} from "@t3tools/contracts/signalboxCollaboration";
import { CloudCollaboration } from "./CloudCollaboration.ts";
import type { CollaborationError } from "./errors.ts";

const transportFailure = (error: CollaborationError) =>
  new OrchestratorMcpFailure({ code: error.code, message: error.message });

type Request<M extends CollaborationMethod> = {
  readonly sourceThreadId: ThreadId;
  readonly input: CollaborationInput<M>;
};

/** Clients, the HTTP API and external MCP all enter the same service. */
export const makeCollaborationHandlers = Effect.map(CloudCollaboration, (service) => ({
  "signalbox.collaboration.capabilities": ({ sourceThreadId, input }: Request<"capabilities">) =>
    service.capabilities(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.list": ({ sourceThreadId, input }: Request<"list">) =>
    service.list(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.read": ({ sourceThreadId, input }: Request<"read">) =>
    service.read(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.send": ({ sourceThreadId, input }: Request<"send">) =>
    service.send(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.wait": ({ sourceThreadId, input }: Request<"wait">) =>
    service.wait(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.delegate": ({ sourceThreadId, input }: Request<"delegate">) =>
    service.delegate(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.status": ({ sourceThreadId, input }: Request<"status">) =>
    service.status(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.cancel": ({ sourceThreadId, input }: Request<"cancel">) =>
    service.cancel(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
  "signalbox.collaboration.interrupt": ({ sourceThreadId, input }: Request<"interrupt">) =>
    service.interrupt(sourceThreadId, input).pipe(Effect.mapError(transportFailure)),
}));
