// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed) and `?contact_id=`. Each conversation embeds its contact +
// tags via the shared CONVERSATION_SELECT.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  buildSortedPage,
  decodeSortCursor,
  nullableKeysetFilter,
  rawCursor,
  isUuid,
} from '@/lib/api/v1/pagination';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit } = parseListParams(request);
    // Decoded here rather than by `parseListParams`, because this list
    // keys on `last_message_at` and that column is nullable.
    const cursor = decodeSortCursor(rawCursor(request));
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');
    if (contactId && !isUuid(contactId)) {
      return fail('bad_request', "'contact_id' must be a contact id (UUID)", 400);
    }

    let query = ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('account_id', ctx.accountId);

    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);

    // Ordered by LAST MESSAGE, not by creation. An inbox is sorted by
    // what happened last: ordering by `created_at` put a customer who
    // wrote minutes ago below a conversation opened months earlier,
    // which is the single thing that made this list unusable as a
    // queue. `nullsFirst: false` keeps never-messaged conversations at
    // the end rather than at the top.
    query = query
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (cursor) {
      const kf = nullableKeysetFilter('last_message_at', cursor);
      if (kf) {
        query = query.or(kf);
      } else {
        // The cursor sits in the null section, which no single `.or()`
        // expresses: everything left is also null, ordered by id.
        query = query.is('last_message_at', null).lt('id', cursor.id);
      }
    }

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = buildSortedPage(
      (data ?? []) as Array<{ id: string; last_message_at: string | null }>,
      limit,
      (row) => row.last_message_at
    );
    return okList(
      items.map((r) =>
        serializeConversation(normalizeConversation(r as Conversation))
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
