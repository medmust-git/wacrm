import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ after: vi.fn() }));

vi.mock('next/server', () => ({ after: h.after }));

import { deferWork, inlineBackgroundWork } from './defer';

const SAVED = process.env.WACRM_INLINE_AFTER;

beforeEach(() => {
  h.after.mockClear();
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.WACRM_INLINE_AFTER;
  else process.env.WACRM_INLINE_AFTER = SAVED;
  vi.restoreAllMocks();
});

describe('deferWork', () => {
  it("hands the task to after() by default, upstream's behaviour", async () => {
    delete process.env.WACRM_INLINE_AFTER;
    const task = vi.fn();
    await deferWork('test', task);
    expect(inlineBackgroundWork()).toBe(false);
    expect(h.after).toHaveBeenCalledWith(task);
    expect(task).not.toHaveBeenCalled();
  });

  it('runs the task to completion before resolving in inline mode', async () => {
    process.env.WACRM_INLINE_AFTER = '1';
    let finished = false;
    await deferWork('test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });
    expect(finished).toBe(true);
    expect(h.after).not.toHaveBeenCalled();
  });

  it('logs a failing inline task instead of failing the request', async () => {
    process.env.WACRM_INLINE_AFTER = '1';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      deferWork('test', async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[defer:test] inline work threw:', 'boom');
  });

  it('only treats "1" as on', () => {
    process.env.WACRM_INLINE_AFTER = 'true';
    expect(inlineBackgroundWork()).toBe(false);
  });
});
