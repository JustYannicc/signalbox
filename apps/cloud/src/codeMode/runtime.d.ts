import "cloudflare:workers";

declare module "cloudflare:workers" {
  export function abortIsolate(reason?: string): never;
}
