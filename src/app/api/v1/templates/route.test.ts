import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ eqCalls: [] as [string, unknown][] }));

function fakeSupabase() {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      mocks.eqCalls.push([column, value]);
      return builder;
    },
    or: () => builder,
    order: () => builder,
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

describe('GET /api/v1/templates', () => {
  it('returns only APPROVED templates by default', async () => {
    // An integration listing templates is about to send one, and Meta
    // refuses every other state — so the default is the set that will
    // actually deliver.
    mocks.eqCalls.length = 0;
    const res = await GET(new Request('https://x.test/api/v1/templates'));
    expect(res.status).toBe(200);
    expect(mocks.eqCalls).toContainEqual(['status', 'APPROVED']);
  });

  it('scopes every query to the account the key belongs to', async () => {
    mocks.eqCalls.length = 0;
    await GET(new Request('https://x.test/api/v1/templates'));
    expect(mocks.eqCalls).toContainEqual(['account_id', 'account-1']);
  });

  it('accepts an explicit status, case-insensitively', async () => {
    mocks.eqCalls.length = 0;
    const res = await GET(
      new Request('https://x.test/api/v1/templates?status=paused')
    );
    expect(res.status).toBe(200);
    expect(mocks.eqCalls).toContainEqual(['status', 'PAUSED']);
  });

  it('applies no status filter for ?status=all', async () => {
    mocks.eqCalls.length = 0;
    const res = await GET(
      new Request('https://x.test/api/v1/templates?status=all')
    );
    expect(res.status).toBe(200);
    expect(mocks.eqCalls.map(([column]) => column)).not.toContain('status');
  });

  it('rejects a status that is not in the schema constraint', async () => {
    const res = await GET(
      new Request('https://x.test/api/v1/templates?status=ACTIVE')
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
  });
});
