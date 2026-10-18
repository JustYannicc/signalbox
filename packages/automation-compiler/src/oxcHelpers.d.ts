// OXC's exported JS helpers have no declarations. Keep their contract beside the pinned adapters.
declare module "oxc-parser/src-js/generated/visit/keys" {
  const keys: Readonly<Record<string, ReadonlyArray<string>>>;
  export default keys;
}
declare module "oxc-parser/src-js/wrap" {
  export function wrap(result: unknown): ReturnType<typeof import("oxc-parser").parseSync>;
}
