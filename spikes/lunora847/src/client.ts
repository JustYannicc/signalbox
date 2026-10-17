import { Effect, Fiber } from "effect";
import { lunoraLayer } from "./adapters/lunora.js";
import { view } from "./view.js";
const fiber = Effect.runFork(
  Effect.scoped(
    view.pipe(Effect.provide(lunoraLayer({ url: location.origin, crossTabSync: false }))),
  ),
);
addEventListener("pagehide", () => Effect.runFork(Fiber.interrupt(fiber)), { once: true });
