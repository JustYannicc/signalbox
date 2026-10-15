// Throwaway stack for #349. `alchemy destroy` removes the Worker and its Durable Object namespace.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "SignalboxSpike349",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
