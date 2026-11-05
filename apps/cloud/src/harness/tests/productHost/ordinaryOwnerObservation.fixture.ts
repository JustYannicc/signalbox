export interface OrdinaryOwnerEvent {
  readonly kind: string;
  readonly realm: string;
  readonly model?: string;
  readonly effort?: string;
  readonly detail?: string;
}

export interface OrdinaryOwnerEnvironment {
  readonly OBSERVE: { record(event: OrdinaryOwnerEvent): Promise<void> };
}
