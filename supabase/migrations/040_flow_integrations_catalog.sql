-- ============================================================
-- 040_flow_integrations_catalog.sql
--
-- Lets a flow talk to an external system and show a store catalogue.
--
--   1. flow_nodes.node_type gains 'send_dynamic_choices' and
--      'send_products'. ('http_fetch' has been allowed by this CHECK
--      since 010 but had no runtime until now.)
--
--   2. flows.trigger_type gains 'order_message' - a flow started when a
--      customer sends a cart from the WhatsApp catalogue. Until now an
--      inbound `order` message was stored as "[Unsupported message type:
--      order]" and the cart was lost.
--
--   3. whatsapp_config.catalog_id - the Meta commerce catalogue connected
--      to the number. Product and catalogue messages must name it; it is
--      per number, so it lives beside phone_number_id.
--
-- Idempotent. Constraint names are Postgres' defaults for the inline
-- CHECKs in 010, matching how 010 and 016 already drop and re-add them.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'send_dynamic_choices',
    'send_products',
    'end'
  ));

ALTER TABLE flows
  DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'order_message'));

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS catalog_id TEXT;
