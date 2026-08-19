// Shared by every vendor adapter stub. The message names the capability and
// the method so a caller hitting it during development knows exactly what to
// build next, not just that something is missing.

export class NotImplementedError extends Error {
  constructor(capability: string, method: string) {
    super(`${capability}.${method} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}
