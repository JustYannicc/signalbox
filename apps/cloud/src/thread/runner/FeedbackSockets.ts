import type {
  FeedbackOutcome,
  FeedbackResponse,
} from "@signalbox/runner-protocol/FeedbackProtocol";
import { threadFrame } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";

import type { FeedbackTransport } from "../ThreadFeedback.ts";

interface FeedbackAttachment {
  readonly generation: number;
  readonly connection: number;
  readonly feedback?: boolean;
}

/** Pending requests hold the object awake. No frame or uploaded content is persisted or logged. */
export class FeedbackSockets {
  private readonly pending = new Map<
    string,
    {
      readonly socket: WebSocket;
      readonly complete: (outcome: FeedbackOutcome) => void;
    }
  >();

  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  readonly upload: FeedbackTransport["Service"]["upload"] = (generation, connection, request) =>
    Effect.callback<FeedbackOutcome>((resume) => {
      const socket = this.ctx.getWebSockets("runner").find((candidate) => {
        const attachment = candidate.deserializeAttachment() as FeedbackAttachment | null;
        return (
          attachment?.generation === generation &&
          attachment.connection === connection &&
          attachment.feedback === true
        );
      });
      if (socket === undefined) {
        resume(Effect.succeed({ _tag: "failed", failure: "runner_unavailable" }));
        return;
      }
      this.pending.set(request.requestId, {
        socket,
        complete: (outcome) => resume(Effect.succeed(outcome)),
      });
      try {
        socket.send(threadFrame.encode(request));
      } catch {
        resume(Effect.succeed({ _tag: "failed", failure: "outcome_unknown" }));
      }
      return Effect.sync(() => {
        this.pending.delete(request.requestId);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.succeed({ _tag: "failed", failure: "outcome_unknown" } as const),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          this.pending.delete(request.requestId);
        }),
      ),
    );

  receive(socket: WebSocket, response: FeedbackResponse) {
    const pending = this.pending.get(response.requestId);
    if (pending?.socket === socket) pending.complete(response.outcome);
  }
}
