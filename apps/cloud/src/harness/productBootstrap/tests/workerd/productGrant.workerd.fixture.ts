export interface ProductFixtureGrant {
  readonly requestId: string;
  readonly call: number;
  readonly kind: "initial" | "turn";
}
