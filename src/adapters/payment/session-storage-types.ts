// DID Connect session/token storage interface (this card's scope item 5).
// The shape is dictated by @arcblock/did-connect-js: WalletHandlers calls
// exactly `create`, `read`, `update`, `delete`, `exist`, `on`, `emit` on
// whatever `tokenStorage` object it is constructed with (verified against
// node_modules/@arcblock/did-connect-js/dist/handlers/{base,util}.js and
// matching the MemStorage in the wallet-test reference script). Row shape is
// deliberately loose (Record<string, unknown>): the library stores
// protocol bookkeeping fields (challenge, sharedKey, currentStep, did, pk,
// status, extraParams, ...) that this interface has no reason to enumerate;
// it is a session bag, not a domain entity.
export interface DidConnectSessionRow {
  readonly token: string;
  readonly status: string;
  [key: string]: unknown;
}

export interface DidConnectSessionStorage {
  create(token: string, status?: string): Promise<DidConnectSessionRow>;
  read(token: string): Promise<DidConnectSessionRow | null>;
  update(token: string, updates: Record<string, unknown>): Promise<DidConnectSessionRow>;
  delete(token: string): Promise<void>;
  exist(token: string, did?: string): Promise<boolean>;
  // Event hooks BaseHandler wires at construction time
  // (tokenStorage.on('create'|'update'|'destroy', ...)); this rail never
  // needs them to fire for the flow to complete (the working reference's
  // MemStorage no-ops them too), but they must exist and be callable.
  on(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}
