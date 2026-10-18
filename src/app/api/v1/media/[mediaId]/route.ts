// ============================================================
// GET /api/v1/media/{mediaId} — fetch a message attachment
// (scope: messages:read).
//
// Why this exists alongside /api/whatsapp/media/{mediaId}: that route
// authenticates with a dashboard SESSION COOKIE, so an API-key caller
// cannot use it. Inbound media is normally mirrored into Storage and
// `media_url` is an absolute https URL that needs no proxy at all —
// but when mirroring is off or fails, the webhook stores the relative
// path `/api/whatsapp/media/<metaMediaId>` instead, and Meta deletes
// the original after about 30 days. Without this route those
// attachments are unreachable to every integration, which for a
// native client means a message that visibly has a photo and no way
// to show it.
//
// Same hardening as the session route — `mediaProxyHeaders` carries
// the CSP, sandbox and attachment-disposition rules from the
// media-proxy XSS fix, and is the single place that policy lives.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { mediaId } = await params;
    if (!mediaId) return fail('bad_request', "'mediaId' is required", 400);

    // Keyed on the account, not the caller: an API key has no user, and
    // the cost being limited is Meta's download bandwidth per account.
    const limit = checkRateLimit(`v1-media:${ctx.accountId}`, RATE_LIMITS.whatsappMedia);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: config } = await ctx.supabase
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!config?.access_token) {
      return fail('whatsapp_not_configured', 'WhatsApp is not configured for this account', 400);
    }

    const accessToken = decrypt(config.access_token);
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
    });
  } catch (err) {
    // Meta returns 404 for media it has already expired (~30 days), and
    // that is the common case here rather than a server fault.
    const message = err instanceof Error ? err.message : '';
    if (/\b404\b|not found/i.test(message)) {
      return fail('not_found', 'That attachment is no longer available from WhatsApp', 404);
    }
    return toApiErrorResponse(err);
  }
}
