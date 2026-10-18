// ============================================================
// GET /api/v1/templates — list message templates
// (scope: templates:read), newest first, keyset-paginated.
//
// Defaults to APPROVED only. A template in any other state cannot be
// sent: Meta refuses DRAFT, PENDING, REJECTED and PENDING_DELETION
// outright, and a PAUSED one is refused until its quality recovers.
// An integration listing templates is almost always about to send
// one, so the default is the set that will actually deliver — pass
// `?status=all` (or a specific status) to see the rest.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { TEMPLATE_SELECT, serializeTemplate } from '@/lib/api/v1/templates';

/** Mirrors `message_templates_status_meta_check` in migration 014. */
const TEMPLATE_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
] as const;

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    const requested = (url.searchParams.get('status') ?? 'APPROVED').toUpperCase();
    if (
      requested !== 'ALL' &&
      !(TEMPLATE_STATUSES as readonly string[]).includes(requested)
    ) {
      return fail(
        'bad_request',
        `'status' must be one of ${TEMPLATE_STATUSES.join(', ')} or all`,
        400
      );
    }

    let query = ctx.supabase
      .from('message_templates')
      .select(TEMPLATE_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (requested !== 'ALL') query = query.eq('status', requested);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/templates] list error:', error);
      return fail('internal', 'Failed to list templates', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((t) => serializeTemplate(t as unknown as Parameters<typeof serializeTemplate>[0])),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
