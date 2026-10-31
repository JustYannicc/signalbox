declare module "signalbox:deploy3-command-registry" {
  export const COMMAND_ASSETS: ReadonlyMap<
    string,
    { readonly path: string; readonly bytes: number }
  >;
}
