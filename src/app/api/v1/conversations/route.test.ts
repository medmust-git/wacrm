import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eqCalls: [] as [string, unknown][],
  orderCalls: [] as [string, unknown][],
}));

function fakeSupabase() {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      mocks.eqCalls.push([column, value]);
      return builder;
    },
    or: () => builder,
    is: () => builder,
    lt: () => builder,
    order: (column: string, options: unknown) => {
      mocks.orderCalls.push([column, options]);
      return builder;
    },
    limit: () => builder,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: [], error: null }),
  };
  return { from: () => builder };
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({
    supabase: fakeSupabase(),
    accountId: 'account-1',
  })),
}));

import { GET } from './route';

describe('GET /api/v1/conversations', () => {
  it('rejects a non-UUID contact_id with 400 bad_request', async () => {
    const res = await GET(
      new Request('https://x.test/api/v1/conversations?contact_id=abc')
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
  });

  it('filters by a valid contact_id', async () => {
    const contactId = '3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b';
    const res = await GET(
      new Request(
        `https://x.test/api/v1/conversations?contact_id=${contactId}`
      )
    );
    expect(res.status).toBe(200);
    expect(mocks.eqCalls).toContainEqual(['contact_id', contactId]);
  });
});

describe('ordering', () => {
  it('orders by last message, newest first, with never-messaged rows last', async () => {
    // An inbox is sorted by what happened last. Ordering by `created_at`
    // put a customer who wrote minutes ago below a conversation opened
    // months earlier, which is what made this list useless as a queue.
    mocks.orderCalls.length = 0;
    await GET(new Request('https://x.test/api/v1/conversations'));
    expect(mocks.orderCalls[0]).toEqual([
      'last_message_at',
      { ascending: false, nullsFirst: false },
    ]);
    // id breaks the tie, and is what the keyset cursor pages on.
    expect(mocks.orderCalls[1]).toEqual(['id', { ascending: false }]);
    expect(mocks.orderCalls.map(([column]) => column)).not.toContain('created_at');
  });
});
