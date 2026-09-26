// Wait for a page's own script to finish its reads, instead of sleeping a
// fixed time. A fixed 250ms wait passed on an idle machine and failed on a
// loaded one: measured on the agent page with three suites running at once,
// the first render of a file had not finished its four reads by 250ms and a
// correct page read as a broken one. Every caller names the signal the page
// itself sets when it is done, so a page that never settles fails loudly
// with that name rather than passing or failing on timing.
export async function settled(
  document: Document,
  ready: (document: Document) => boolean,
  what: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready(document)) {
    if (Date.now() > deadline) throw new Error(`${what} did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The agent page is done when renderSummary has removed #summary's
// data-pending (every section renders in the same callback, after the four
// reads resolve) or when failLoad has shown #load-error.
export function agentPageReady(document: Document): boolean {
  const summary = document.getElementById('summary');
  const error = document.getElementById('load-error') as HTMLElement | null;
  return (summary !== null && !summary.hasAttribute('data-pending')) || (error !== null && !error.hidden);
}

// The receipt is done when render has removed #claim's data-pending or
// failLoad has shown #load-error. The agent's name arrives from a second
// read after that; a test that needs the name waits for it by value.
export function receiptPageReady(document: Document): boolean {
  const claim = document.getElementById('claim');
  const error = document.getElementById('load-error') as HTMLElement | null;
  return (claim !== null && !claim.hasAttribute('data-pending')) || (error !== null && !error.hidden);
}
