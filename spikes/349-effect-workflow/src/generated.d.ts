// Compiled automations are plain ES modules whose default export is `workflow(…)`.
declare module "*.js" {
  const definition: unknown;
  export default definition;
}

interface ImportMeta {
  readonly url: string;
}
