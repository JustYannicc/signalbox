import { WorkerEntrypoint } from "cloudflare:workers";

export interface HarnessProgramAssetsBindingEnvironment {
  readonly PROGRAM_ASSETS: Fetcher;
}

/** Keeps the Wrangler assets fetcher behind a service binding in product Workers. */
export class HarnessProgramAssetsBinding extends WorkerEntrypoint<HarnessProgramAssetsBindingEnvironment> {
  override fetch(request: Request): Promise<Response> {
    return this.env.PROGRAM_ASSETS.fetch(request);
  }
}
