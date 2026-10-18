-- ============================================================
-- 101_flow_set_vars.sql
--
-- Numbered 101 (was 041, then 044) to stay clear of upstream's sequence;
-- already applied to production under its earlier numbers.
--
-- flow_nodes.node_type gains 'set_vars': sets run variables from templates.
-- Lets branches converge - an order picked from a list and an order found
-- by typed number land in different variables, and the steps after them
-- should read one.
--
-- Idempotent; drops and re-adds the CHECK as 010, 016 and 043 do.
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
    'set_vars',
    'end'
  ));
