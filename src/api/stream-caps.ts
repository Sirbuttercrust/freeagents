// SW4-04 (bugs.md): one caller must not be able to hold unlimited live
// streams open. A stream is one request that never ends, so the request
// limiter cannot bound what it holds; this counts the open sockets instead.
//
// The counting lives here, apart from express, so the two rules (a cap per
// target and a cap across every target) read in one place and the routes only
// ask "may this caller open one more?" and, when the answer is yes, hold the
// place until the connection closes.

// What the conversation page opens for one conversation is ONE stream
// (src/web/public/js/pages/messages.js opens one and stops it before opening
// the next). Three leaves room for a second tab on the same conversation and
// for a reconnect that opens before the dead socket has been noticed.
export const STREAM_LIMIT_PER_TARGET = 3;

// The page holds one stream at a time, so ten is far past any real use. It
// exists so that a caller cannot get around the per-target cap by opening
// three streams on each of many conversations; the rest is room for a handful
// of tabs, each on its own conversation, plus the notification stream.
export const STREAM_LIMIT_PER_CALLER = 10;

export type StreamRefusal = 'target' | 'caller';

export interface StreamPlace {
  // Gives the place back. Safe to call more than once: only the first call
  // counts, so a close event and an already-closed check can both run.
  readonly release: () => void;
}

export interface StreamCaps {
  // A place for `caller` on `target`, or the cap that refused it. `caller` is
  // the acting DID exactly as the route resolved it; `target` names what is
  // being streamed (one job's thread, one account's notifications).
  acquire(caller: string, target: string): StreamPlace | StreamRefusal;
}

interface CallerEntry {
  total: number;
  readonly perTarget: Map<string, number>;
}

export function createStreamCaps(): StreamCaps {
  const callers = new Map<string, CallerEntry>();

  function give(caller: string, target: string): void {
    const entry = callers.get(caller);
    if (entry === undefined) return;
    const held = entry.perTarget.get(target) ?? 0;
    if (held <= 0) return;
    if (held === 1) entry.perTarget.delete(target);
    else entry.perTarget.set(target, held - 1);
    entry.total -= 1;
    // A caller with no open stream leaves nothing behind.
    if (entry.total <= 0) callers.delete(caller);
  }

  return {
    acquire(caller, target) {
      const entry = callers.get(caller) ?? { total: 0, perTarget: new Map<string, number>() };
      const held = entry.perTarget.get(target) ?? 0;
      if (held >= STREAM_LIMIT_PER_TARGET) return 'target';
      if (entry.total >= STREAM_LIMIT_PER_CALLER) return 'caller';
      entry.perTarget.set(target, held + 1);
      entry.total += 1;
      callers.set(caller, entry);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          give(caller, target);
        },
      };
    },
  };
}

// One sentence a person can act on for each route and each cap, so the words
// name the cap that actually refused: the per-target one names the
// conversation or the notifications, the across-everything one names the
// account and says which stream was not opened.
export type StreamRoute = 'thread' | 'notifications';

export function refusalSentence(route: StreamRoute, cap: StreamRefusal): string {
  if (route === 'thread') {
    return cap === 'target'
      ? 'Too many live connections are open for this conversation. Close another tab, or wait a moment and try again.'
      : 'Too many live connections are open for this account, so this conversation did not open a live one. Close a tab on another page, or wait a moment and try again.';
  }
  return cap === 'target'
    ? 'Too many live connections are open for these notifications. Close another tab, or wait a moment and try again.'
    : 'Too many live connections are open for this account, so the notifications did not open a live one. Close a tab on another page, or wait a moment and try again.';
}

// Seconds a refused caller is told to wait. A closed tab frees its place at
// once, so this is only how long an automatic retry should back off.
export const STREAM_RETRY_AFTER_SECONDS = 30;

// The part of a node response this needs: whether its socket is already gone,
// and a way to hear it go.
export interface ClosableResponse {
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
}

// Ties a place to the connection it was taken for. Returns false, with the
// place already given back, when the connection closed while the route was
// still awaiting its checks: a close event that fired before anyone listened
// is never delivered, so without this check that place would be held forever.
// `res.destroyed` is what says so (measured on Node 22: a client that aborts
// mid-request leaves res.destroyed, res.closed and req.socket.destroyed true).
export function holdUntilClosed(place: StreamPlace, res: ClosableResponse, onClose: () => void = () => undefined): boolean {
  if (res.destroyed) {
    place.release();
    return false;
  }
  res.once('close', () => {
    place.release();
    onClose();
  });
  return true;
}
