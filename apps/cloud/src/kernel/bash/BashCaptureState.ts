export interface BashCaptureState {
  readonly stack: { readonly low: number; readonly high: number; readonly log: number };
  readonly base: number;
  readonly size: number;
  readonly names: readonly (readonly [number, number])[];
  readonly stackNames: readonly number[];
  readonly captures: readonly (readonly [
    number,
    {
      readonly at: number;
      readonly length: number;
      readonly env: number;
      readonly generation: number;
      readonly sp: number;
      readonly refs: number;
    },
  ])[];
  readonly top: number;
  readonly liveBytes: number;
  readonly nextId: number;
  readonly nextGeneration: number;
}
