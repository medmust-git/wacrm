// ============================================================
// Work that upstream runs after the response, made safe for a host
// that stops the CPU once the response is sent.
//
// Upstream hands slow follow-up work to Next's `after()`: the response
// goes out fast and the runtime keeps the process alive until the work
// resolves. That holds on Vercel and on an always-on Node server. It
// does NOT hold on Cloud Run with request-based billing, where CPU is
// throttled to almost nothing the moment the response is sent - the
// work stalls mid-flight, which is how inbound messages went missing
// in issue #301.
//
// This fork runs on Cloud Run, and keeping CPU always allocated so
// `after()` works meant one instance billed around the clock (the
// 5-minute crons never let it idle out). With WACRM_INLINE_AFTER=1 the
// work runs before the response instead: slower acks, but every request
// finishes its own work and the service can bill per request and scale
// to zero. Unset, behaviour is exactly upstream's.
//
// See docs/fork-sync.md, "Cloud Run billing".
// ============================================================

import { after } from 'next/server';

export function inlineBackgroundWork(): boolean {
  return process.env.WACRM_INLINE_AFTER === '1';
}

/**
 * Run `task` after the response (default) or before it (inline mode).
 *
 * Never throws in either mode: inline errors are logged under `label`,
 * so follow-up work failing cannot turn an already-successful request
 * into an error response - the same contract `after()` gives.
 */
export async function deferWork(
  label: string,
  task: () => Promise<unknown> | unknown
): Promise<void> {
  if (!inlineBackgroundWork()) {
    after(task);
    return;
  }
  try {
    await task();
  } catch (err) {
    console.error(
      `[defer:${label}] inline work threw:`,
      err instanceof Error ? err.message : err
    );
  }
}
