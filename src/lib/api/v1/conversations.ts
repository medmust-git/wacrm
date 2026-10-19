// ============================================================
// Public API (v1) serializers for conversations + messages.
//
// The dashboard's `Conversation`/`Message` rows carry internal columns
// (account_id, user_id, sender_id) that shouldn't leak onto the public
// wire. These serializers project the stable public subset and rename
// the Meta id (`message_id` → `whatsapp_message_id`) to match the send
// endpoint's response vocabulary.
// ============================================================

import type { Conversation, Message } from '@/types';

/**
 * The `ilike` pattern for `?phone=`, or null when there is nothing to match.
 *
 * Digits only, because the same number is stored as `+916235255666` here and
 * typed as `+91 62352 55666`, `916235255666` or `6235255666` elsewhere. Ten
 * digits is the floor: a shorter query is a substring of half the directory,
 * and `ilike` has no word boundary to lean on.
 *
 * It is a CONTAINS match by design, so a caller holding a bare national number
 * finds a contact stored with its country code. The caller is therefore
 * expected to verify the number it gets back - an exact match here would
 * simply refuse the common case instead.
 */
export function conversationPhoneFilter(raw: string | null): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `%${digits}%` : null;
}

export interface ApiConversation {
  id: string;
  contact_id: string;
  status: string;
  assigned_agent_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    company: string | null;
    tags: { id: string; name: string; color: string }[];
  } | null;
}

export interface ApiMessage {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound';
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  /**
   * The attachment's MIME type, for inbound media. A client picks a
   * renderer from this instead of guessing from the URL's extension -
   * a mirrored Storage object does not always carry one, and a
   * proxied `/api/whatsapp/media/<id>` path never does.
   */
  media_type: string | null;
  template_name: string | null;
  whatsapp_message_id: string | null;
  status: string;
  reply_to_message_id: string | null;
  interactive_reply_id: string | null;
  created_at: string;
}

/**
 * Project a normalized `Conversation` (from `normalizeConversation`,
 * which has already flattened `contact.tags`) into the public shape.
 */
export function serializeConversation(conv: Conversation): ApiConversation {
  const c = conv.contact;
  return {
    id: conv.id,
    contact_id: conv.contact_id,
    status: conv.status,
    assigned_agent_id: conv.assigned_agent_id ?? null,
    last_message_text: conv.last_message_text ?? null,
    last_message_at: conv.last_message_at ?? null,
    unread_count: conv.unread_count ?? 0,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    contact: c
      ? {
          id: c.id,
          phone: c.phone,
          name: c.name ?? null,
          email: c.email ?? null,
          company: c.company ?? null,
          tags: (c.tags ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
          })),
        }
      : null,
  };
}

/** Project a `messages` row into the public shape. */
export function serializeMessage(m: Message): ApiMessage {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    // `customer` = inbound (from the contact); anything else is outbound.
    direction: m.sender_type === 'customer' ? 'inbound' : 'outbound',
    sender_type: m.sender_type,
    content_type: m.content_type,
    content_text: m.content_text ?? null,
    media_url: m.media_url ?? null,
    media_type: m.media_type ?? null,
    template_name: m.template_name ?? null,
    whatsapp_message_id: m.message_id ?? null,
    status: m.status,
    reply_to_message_id: m.reply_to_message_id ?? null,
    interactive_reply_id: m.interactive_reply_id ?? null,
    created_at: m.created_at,
  };
}
