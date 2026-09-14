import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { shouldAskForFeedback } from '@/lib/conversations/feedback'

type Params = { params: Promise<{ id: string }> }

const STATUSES = new Set(['open', 'pending', 'closed'])

/**
 * POST /api/conversations/[id]/status  (agent+)
 *
 * Sets a conversation's status from the inbox. A server route rather than a
 * client-side update so that closing a conversation can fire the
 * `conversation_closed` automation trigger - "how did we do?" after a chat
 * with staff - which a browser write has no way to do.
 *
 * Body: { status: 'open' | 'pending' | 'closed' }
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = await request.json().catch(() => null)
    const status = typeof body?.status === 'string' ? body.status : ''
    if (!STATUSES.has(status)) {
      return NextResponse.json({ error: 'status must be open, pending or closed' }, { status: 400 })
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, status, contact_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[conversations/status] lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const { error: updErr } = await supabase
      .from('conversations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
    if (updErr) {
      console.error('[conversations/status] update error:', updErr)
      return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 })
    }

    if (status === 'closed' && conv.status !== 'closed' && conv.contact_id) {
      // After the response: the automation sends a WhatsApp message, and the
      // agent's click must not wait on Meta.
      after(async () => {
        const db = supabaseAdmin()
        const latest = async (senderType: 'agent' | 'customer') => {
          const { data } = await db
            .from('messages')
            .select('created_at')
            .eq('conversation_id', id)
            .eq('sender_type', senderType)
            .order('created_at', { ascending: false })
            .limit(1)
          return (data as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null
        }
        const [lastAgentMessageAt, lastCustomerMessageAt] = await Promise.all([latest('agent'), latest('customer')])
        if (!shouldAskForFeedback({ previousStatus: conv.status, nextStatus: status, lastAgentMessageAt, lastCustomerMessageAt })) return
        await runAutomationsForTrigger({
          accountId,
          triggerType: 'conversation_closed',
          contactId: conv.contact_id,
          context: { conversation_id: id },
        })
      })
    }

    return NextResponse.json({ status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
