export function createCloudflareWorkersMock() {
  class Context {
    readonly ctx: unknown;
    readonly env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  return {
    DurableObject: class extends Context {},
    WorkerEntrypoint: class extends Context {},
    WorkflowEntrypoint: class extends Context {},
    RpcTarget: Object,
    exports: {},
  };
}
