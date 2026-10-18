import { describe, expect, it } from 'vitest';
import {
  buildSortedPage,
  decodeSortCursor,
  encodeSortCursor,
  nullableKeysetFilter,
} from './pagination';

const ID = '3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b';
const OTHER = '11111111-2222-3333-4444-555555555555';

describe('sort cursors', () => {
  it('round-trips a timestamp cursor', () => {
    const encoded = encodeSortCursor('2026-10-18T10:00:00.000Z', ID);
    expect(decodeSortCursor(encoded)).toEqual({
      value: '2026-10-18T10:00:00.000Z',
      id: ID,
    });
  });

  it('round-trips a null cursor, which is the null section of the ordering', () => {
    // A conversation with no messages yet sorts last, and paging has to
    // be able to sit there.
    expect(decodeSortCursor(encodeSortCursor(null, ID))).toEqual({
      value: null,
      id: ID,
    });
  });

  it('refuses anything not plausibly server-issued', () => {
    // The values are interpolated raw into a PostgREST filter, so a
    // hand-crafted cursor must decode to "no cursor", never to a query.
    expect(decodeSortCursor(null)).toBeNull();
    expect(decodeSortCursor('')).toBeNull();
    expect(decodeSortCursor(Buffer.from('x|y').toString('base64url'))).toBeNull();
    expect(
      decodeSortCursor(Buffer.from(`not-a-date|${ID}`).toString('base64url'))
    ).toBeNull();
    expect(
      decodeSortCursor(
        Buffer.from(`2026-10-18T10:00:00.000Z|id.lt.0)`).toString('base64url')
      )
    ).toBeNull();
  });
});

describe('nullableKeysetFilter', () => {
  it('walks past a timestamped row, and lets the null section follow', () => {
    const filter = nullableKeysetFilter('last_message_at', {
      value: '2026-10-18T10:00:00.000Z',
      id: ID,
    });
    expect(filter).toBe(
      `last_message_at.lt.2026-10-18T10:00:00.000Z,and(last_message_at.eq.2026-10-18T10:00:00.000Z,id.lt.${ID}),last_message_at.is.null`
    );
  });

  it('returns null inside the null section, which no single or() expresses', () => {
    // The caller applies `.is(column, null).lt('id', …)` instead.
    expect(nullableKeysetFilter('last_message_at', { value: null, id: ID })).toBeNull();
  });
});

describe('buildSortedPage', () => {
  const row = (id: string, last_message_at: string | null) => ({ id, last_message_at });

  it('is the last page when nothing was over-fetched', () => {
    const page = buildSortedPage([row(ID, '2026-10-18T10:00:00.000Z')], 5, (r) => r.last_message_at);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it('trims the over-fetched row and cursors on the sort column', () => {
    const rows = [row(ID, '2026-10-18T10:00:00.000Z'), row(OTHER, '2026-10-17T10:00:00.000Z')];
    const page = buildSortedPage(rows, 1, (r) => r.last_message_at);
    expect(page.items).toEqual([rows[0]]);
    expect(decodeSortCursor(page.nextCursor)).toEqual({
      value: '2026-10-18T10:00:00.000Z',
      id: ID,
    });
  });

  it('cursors correctly off a row with no last message', () => {
    const rows = [row(ID, null), row(OTHER, null)];
    const page = buildSortedPage(rows, 1, (r) => r.last_message_at);
    expect(decodeSortCursor(page.nextCursor)).toEqual({ value: null, id: ID });
  });
});
