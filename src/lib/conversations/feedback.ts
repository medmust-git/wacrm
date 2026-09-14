/**
 * Whether closing a conversation should ask the customer how it went
 * (the `conversation_closed` automation trigger).
 *
 * Only after a real conversation with staff, and only while a free-form
 * message can still be delivered:
 *
 * - a staff member wrote in it within the last day - closing a chat only the
 *   bot handled, or an old one being tidied up, must not ask anybody anything;
 * - the customer's last message is inside Meta's 24-hour customer-service
 *   window, minus an hour of margin, since buttons are not a template and
 *   Meta refuses them outside it.
 */
export const FEEDBACK_AGENT_WINDOW_MS = 24 * 60 * 60 * 1000
export const FEEDBACK_CUSTOMER_WINDOW_MS = 23 * 60 * 60 * 1000

export function shouldAskForFeedback(args: {
  previousStatus: string
  nextStatus: string
  lastAgentMessageAt: string | null
  lastCustomerMessageAt: string | null
  now?: number
}): boolean {
  if (args.nextStatus !== 'closed' || args.previousStatus === 'closed') return false
  const now = args.now ?? Date.now()
  const agent = Date.parse(args.lastAgentMessageAt ?? '')
  const customer = Date.parse(args.lastCustomerMessageAt ?? '')
  if (!Number.isFinite(agent) || !Number.isFinite(customer)) return false
  return now - agent <= FEEDBACK_AGENT_WINDOW_MS && now - customer <= FEEDBACK_CUSTOMER_WINDOW_MS
}
