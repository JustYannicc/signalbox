import * as Effect from "effect/Effect";
import type { ThreadId } from "@t3tools/contracts";
import type {
  CollaborationInput,
  CollaborationMethod,
} from "@t3tools/contracts/signalboxCollaboration";
import { CloudCollaboration } from "./CloudCollaboration.ts";

type Request<M extends CollaborationMethod> = {
  readonly sourceThreadId: ThreadId;
  readonly input: CollaborationInput<M>;
};

/** Clients, the HTTP API and external MCP all enter the same service. */
export const makeCollaborationHandlers = Effect.map(CloudCollaboration, (service) => ({
  "signalbox.collaboration.capabilities": ({ sourceThreadId, input }: Request<"capabilities">) =>
    service.capabilities(sourceThreadId, input),
  "signalbox.collaboration.list": ({ sourceThreadId, input }: Request<"list">) =>
    service.list(sourceThreadId, input),
  "signalbox.collaboration.read": ({ sourceThreadId, input }: Request<"read">) =>
    service.read(sourceThreadId, input),
  "signalbox.collaboration.send": ({ sourceThreadId, input }: Request<"send">) =>
    service.send(sourceThreadId, input),
  "signalbox.collaboration.wait": ({ sourceThreadId, input }: Request<"wait">) =>
    service.wait(sourceThreadId, input),
  "signalbox.collaboration.delegate": ({ sourceThreadId, input }: Request<"delegate">) =>
    service.delegate(sourceThreadId, input),
  "signalbox.collaboration.status": ({ sourceThreadId, input }: Request<"status">) =>
    service.status(sourceThreadId, input),
  "signalbox.collaboration.cancel": ({ sourceThreadId, input }: Request<"cancel">) =>
    service.cancel(sourceThreadId, input),
  "signalbox.collaboration.interrupt": ({ sourceThreadId, input }: Request<"interrupt">) =>
    service.interrupt(sourceThreadId, input),
}));
