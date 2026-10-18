// ============================================================
// Cursor pagination for public API (v1) list endpoints.
//
// Every `/api/v1` list route (contacts, conversations, messages,
// broadcasts) pages the same way so integrators write one loop:
//
//   GET /api/v1/contacts?limit=50
//   → { "data": [...], "meta": { "next_cursor": "…" } }
//   GET /api/v1/contacts?limit=50&cursor=…      // next page
//   → { "data": [...], "meta": { "next_cursor": null } }   // last page
//
// Cursors are **keyset** (not offset): rows are ordered by
// `(created_at, id)` descending and the cursor encodes the last row's
// `(created_at, id)`. This is stable under concurrent inserts (an
// offset would skip/repeat rows when new data lands mid-scan) and
// stays fast at any depth. The cursor is an opaque base64 string —
// clients pass it back verbatim and never parse it.
// ============================================================

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface Cursor {
  createdAt: string;
  id: string;
}

export interface ListParams {
  /** Clamped to [1, MAX_LIMIT]. */
  limit: number;
  /** Decoded cursor, or null on the first page. */
  cursor: Cursor | null;
}

/**
 * Parse `?limit` and `?cursor` off a request URL. `limit` is clamped
 * to [1, MAX_LIMIT] (default {@link DEFAULT_LIMIT}); a malformed or
 * unparseable `cursor` is treated as absent (first page) rather than
 * erroring — the worst case is the client re-reads from the top.
 */
export function parseListParams(request: Request): ListParams {
  const url = new URL(request.url);

  const rawLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT;

  return { limit, cursor: decodeCursor(url.searchParams.get('cursor')) };
}

/** Encode a row's `(created_at, id)` into an opaque cursor string. */
export function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`, 'utf8').toString(
    'base64url'
  );
}

// A cursor is only ever minted by `encodeCursor` from a real row's
// `created_at` (ISO timestamp) + `id` (UUID). We re-validate both on
// decode so a hand-crafted cursor can't smuggle PostgREST filter
// syntax into `keysetFilter`'s `.or()` string (the values are
// interpolated raw). Anything that doesn't look server-issued is
// treated as "no cursor" — the documented tolerance is to restart
// from the first page, never to run an attacker-shaped query.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Decode a cursor string, or null if missing/malformed/untrusted. */
export function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const createdAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    // Reject anything that isn't a plausible server-issued cursor: an
    // ISO-8601 timestamp and a UUID. This is what keeps the raw
    // interpolation in `keysetFilter` safe.
    if (!UUID_RE.test(id)) return null;
    const ts = Date.parse(createdAt);
    if (Number.isNaN(ts)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * PostgREST `.or()` expression that walks *past* the cursor row under
 * a `(created_at desc, id desc)` ordering: strictly-older rows, plus
 * same-timestamp rows with a smaller id (the tie-breaker). Returns
 * null on the first page. Apply as:
 *
 *   let q = db.from('contacts').select('*').eq('account_id', accountId)
 *     .order('created_at', { ascending: false })
 *     .order('id', { ascending: false })
 *     .limit(limit + 1)          // fetch one extra to detect a next page
 *   const f = keysetFilter(cursor)
 *   if (f) q = q.or(f)
 */
export function keysetFilter(cursor: Cursor | null): string | null {
  if (!cursor) return null;
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

/**
 * Trim an over-fetched result set (query ran with `limit + 1`) down to
 * `limit` and derive the `next_cursor`. When fewer than `limit + 1`
 * rows came back, this is the last page and `nextCursor` is null.
 */
export function buildPage<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(items[items.length - 1]) };
}

// ============================================================
// Keyset paging on a NULLABLE sort column.
//
// The conversations list sorts by `last_message_at`, not `created_at`:
// an inbox is ordered by what happened last, not by when a thread was
// first opened. That column is nullable (a conversation created with
// no message yet), so the ordering is
//
//   last_message_at DESC NULLS LAST, id DESC
//
// and the cursor has to be able to sit in the null section. The
// helpers above stay as they are - contacts, messages and broadcasts
// still page by a non-null `created_at`, and changing their cursor
// shape would invalidate every cursor already in flight.
// ============================================================

export interface SortCursor {
  /** The sort column's value, or null when the cursor row had none. */
  value: string | null;
  id: string;
}

/** Encode a `(sortValue, id)` cursor. A null value encodes as empty. */
export function encodeSortCursor(value: string | null, id: string): string {
  return Buffer.from(`${value ?? ''}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decode a sort cursor, or null if missing/malformed/untrusted. Same
 * contract as `decodeCursor`: anything not plausibly server-issued is
 * treated as "no cursor" rather than erroring, because the values are
 * interpolated raw into a PostgREST filter.
 */
export function decodeSortCursor(raw: string | null): SortCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const value = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!UUID_RE.test(id)) return null;
    // An empty value is the null section of the ordering, which is a
    // legitimate place for a cursor to be. Anything else must parse as
    // a timestamp.
    if (value === '') return { value: null, id };
    if (Number.isNaN(Date.parse(value))) return null;
    return { value, id };
  } catch {
    return null;
  }
}

/** The raw `?cursor=` string, for routes decoding it themselves. */
export function rawCursor(request: Request): string | null {
  return new URL(request.url).searchParams.get('cursor');
}

/**
 * PostgREST `.or()` expression walking past a cursor row under
 * `<column> DESC NULLS LAST, id DESC`, or null when the cursor sits in
 * the null section - that case cannot be expressed as one `.or()` and
 * the caller applies `.is(column, null).lt('id', cursor.id)` instead.
 */
export function nullableKeysetFilter(
  column: string,
  cursor: SortCursor
): string | null {
  if (cursor.value === null) return null;
  // Strictly older, or the same instant with a smaller id, or anything
  // in the null section - nulls sort last, so they all come after.
  return [
    `${column}.lt.${cursor.value}`,
    `and(${column}.eq.${cursor.value},id.lt.${cursor.id})`,
    `${column}.is.null`,
  ].join(',');
}

/**
 * Trim an over-fetched page and derive the next cursor from a chosen
 * column, rather than from `created_at`.
 */
export function buildSortedPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortValue: (row: T) => string | null
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: encodeSortCursor(sortValue(last), last.id) };
}
