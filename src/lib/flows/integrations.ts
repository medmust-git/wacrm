/**
 * Flow nodes that talk to other systems: `http_fetch`,
 * `send_dynamic_choices` and `send_products`.
 *
 * Until these existed a flow could only say what its author typed into
 * the builder. Every list and button row was static JSON, so a bot could
 * not offer "which of YOUR orders?" - and `http_fetch`, although allowed
 * by the node_type CHECK since migration 010, had no runtime at all.
 *
 * Everything here is pure or takes its I/O as arguments, so it is unit
 * tested without Supabase or Meta. `engine.ts` wires it into the advance
 * loop and the reply matcher.
 *
 * ## The contract with an external API
 *
 * `http_fetch` stores the parsed JSON response under `vars[save_as]`, and
 * every later node reads it through dotted placeholders
 * (`{{vars.order.text}}`) or a `source` path. It branches on transport
 * only: 2xx with a JSON object takes `success_next`, anything else takes
 * `error_next`. A business outcome ("no orders on this number") belongs in
 * the response body and a `condition` node, not in an HTTP status - an API
 * that answers 404 for "none" routes a customer to the error branch.
 */

import type { FlowNodeRow } from "./types";

// ============================================================
// Config shapes
// ============================================================

/**
 * Sets run variables from templates, then advances.
 *
 * Exists so branches can converge: the order a customer picked from a list
 * and the order they typed the number of arrive in different variables, and
 * everything after ("show it", "send its invoice") should read one.
 * Values are stored as strings; an empty template clears a variable.
 */
export interface SetVarsNodeConfig {
  values: Record<string, string>;
  next_node_key: string;
}

export function computeSetVars(cfg: SetVarsNodeConfig, ctx: InterpolationContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(cfg.values ?? {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    out[key] = interpolateTemplate(template, ctx);
  }
  return out;
}

export interface HttpFetchNodeConfig {
  method: "GET" | "POST";
  /** May contain placeholders; values are URL-encoded when substituted. */
  url: string;
  /**
   * Static header values. A value may be exactly `{{env.FLOW_SECRET_NAME}}`,
   * read from the server environment. Only `FLOW_SECRET_*` names resolve,
   * so flow JSON cannot exfiltrate the Supabase service key or the Meta
   * app secret by naming them.
   */
  headers?: Record<string, string>;
  /**
   * JSON body template for POST. Placeholders are JSON-escaped inside
   * strings; `{{json:vars.path}}` inserts a value as raw JSON (an array or
   * object). Omitted, the body is `{ wa_phone, contact_name, vars }`.
   */
  body?: string;
  /** Key under `vars` for the parsed response. */
  save_as: string;
  /** Capped at 10s. */
  timeout_ms?: number;
  success_next: string;
  error_next: string;
}

export interface DynamicChoiceExtraRow {
  reply_id: string;
  title: string;
  description?: string;
  next_node_key: string;
}

export interface SendDynamicChoicesNodeConfig {
  text: string;
  /** List button label; unused when the choices fit in buttons. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** Dotted path under `vars` to an array, e.g. `orders.choices`. */
  source: string;
  id_field: string;
  title_field: string;
  description_field?: string;
  /** Where the tapped item's id is stored, under `vars`. */
  save_selection_as: string;
  /** Taken after any item is tapped. */
  next_node_key: string;
  /** Taken without sending anything when the array is empty or missing. */
  empty_next: string;
  /** Fixed rows appended after the items, e.g. "Something else". */
  extra_rows?: DynamicChoiceExtraRow[];
}

export interface SendProductsNodeConfig {
  /**
   * `catalog`      - the whole catalogue, one "View catalogue" button.
   * `product`      - one product card.
   * `product_list` - up to 30 products in one section.
   */
  mode: "catalog" | "product" | "product_list";
  body_text: string;
  header_text?: string;
  footer_text?: string;
  /** Dotted path under `vars` to an array of retailer ids. */
  retailer_ids_source?: string;
  /** Static retailer ids, used when no source is set. */
  retailer_ids?: string[];
  section_title?: string;
  next_node_key: string;
  /**
   * Taken when there is nothing to show (no ids, or no catalogue connected).
   * Defaults to `next_node_key`, so a missing catalogue skips the message
   * rather than failing the run.
   */
  empty_next?: string;
}

// ============================================================
// Placeholders
// ============================================================

export interface InterpolationContext {
  vars: Record<string, unknown>;
  contact?: { phone?: string | null; name?: string | null } | null;
}

/**
 * Reads `a.b.0.c` from an object. Array indexes are numeric segments.
 * Undefined for any missing step - never throws.
 */
export function readPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function resolvePlaceholder(expression: string, ctx: InterpolationContext): unknown {
  if (expression.startsWith("vars.")) return readPath(ctx.vars, expression.slice(5));
  if (expression === "contact.phone") return ctx.contact?.phone ?? undefined;
  if (expression === "contact.name") return ctx.contact?.name ?? undefined;
  if (expression === "contact.first_name") return firstName(ctx.contact?.name);
  return undefined;
}

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "sir"]);

/**
 * The first name in a WhatsApp profile name, for a greeting - or undefined
 * when there is nothing that reads as a name ("~", a phone number, emoji
 * only), so a `{{contact.first_name|there}}` fallback takes over instead of
 * "Hi 919876543210". A leading title is skipped: "Dr. Anjali" greets Anjali.
 */
export function firstName(name: string | null | undefined): string | undefined {
  const words = (name ?? "")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}'-]/gu, ""))
    .filter((word) => /\p{L}{2,}/u.test(word));
  const first = words.find((word) => !HONORIFICS.has(word.toLowerCase()));
  if (!first || first.length > 20) return undefined;
  return first === first.toUpperCase() || first === first.toLowerCase()
    ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
    : first;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// `{{expr|fallback}}` renders the fallback when the value is empty, e.g.
// `Hi {{contact.first_name|there}}`.
const PLACEHOLDER = /\{\{\s*(json:)?((?:vars\.[a-zA-Z0-9_.]+)|contact\.(?:phone|name|first_name))\s*(?:\|([^{}]*))?\}\}/g;

function valueOr(value: unknown, fallback: string | undefined): unknown {
  return fallback !== undefined && stringify(value) === "" ? fallback.trim() : value;
}

/**
 * Fills `{{vars.a.b}}`, `{{contact.phone}}` and `{{contact.name}}` in text.
 * A missing value renders as the empty string, matching the previous
 * flat `{{vars.key}}` behaviour, which remains a valid subset.
 */
export function interpolateTemplate(template: string | undefined, ctx: InterpolationContext): string {
  if (!template) return "";
  return template.replace(PLACEHOLDER, (_match, _json, expression: string, fallback?: string) =>
    stringify(valueOr(resolvePlaceholder(expression, ctx), fallback)),
  );
}

/** As `interpolateTemplate`, but every value is URL-encoded. For URLs. */
export function interpolateUrl(template: string, ctx: InterpolationContext): string {
  return template.replace(PLACEHOLDER, (_match, _json, expression: string, fallback?: string) =>
    encodeURIComponent(stringify(valueOr(resolvePlaceholder(expression, ctx), fallback))),
  );
}

/**
 * Fills a JSON body template. A plain placeholder is escaped for use inside a
 * JSON string literal - so a customer who types a quote cannot break out of
 * the string and add fields. `{{json:vars.x}}` inserts raw JSON.
 */
export function interpolateJsonBody(template: string, ctx: InterpolationContext): string {
  return template.replace(PLACEHOLDER, (_match, json: string | undefined, expression: string, fallback?: string) => {
    const value = valueOr(resolvePlaceholder(expression, ctx), fallback);
    if (json) return JSON.stringify(value ?? null);
    return JSON.stringify(stringify(value)).slice(1, -1);
  });
}

// ============================================================
// http_fetch
// ============================================================

export const HTTP_FETCH_MAX_TIMEOUT_MS = 10_000;
export const HTTP_FETCH_MAX_RESPONSE_BYTES = 64 * 1024;

const ENV_PLACEHOLDER = /^\{\{\s*env\.(FLOW_SECRET_[A-Z0-9_]+)\s*\}\}$/;

/**
 * A header value, with `{{env.FLOW_SECRET_*}}` resolved. Any other `{{env.*}}`
 * name, or an unset one, is null - the request is then refused rather than
 * sent with a literal placeholder or an empty credential.
 */
export function resolveHeaderValue(value: string, env: Record<string, string | undefined>): string | null {
  const match = ENV_PLACEHOLDER.exec(value.trim());
  if (!match) return /\{\{\s*env\./.test(value) ? null : value;
  const secret = env[match[1]];
  return secret ? secret : null;
}

export interface HttpFetchDeps {
  fetch: typeof fetch;
  isDeliverableUrl: (url: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
}

export type HttpFetchOutcome =
  | { ok: true; data: Record<string, unknown>; status: number }
  | { ok: false; reason: string; status?: number };

export async function executeHttpFetch(
  cfg: HttpFetchNodeConfig,
  ctx: InterpolationContext,
  deps: HttpFetchDeps,
): Promise<HttpFetchOutcome> {
  if (!cfg.url) return { ok: false, reason: "missing_url" };
  const url = interpolateUrl(cfg.url, ctx);
  // Same guard as automations' send_webhook: the URL is account-authored
  // and the server makes the request, so a private or loopback destination
  // is refused. Redirects are not followed, so a public URL cannot bounce
  // the request inward either.
  if (!(await deps.isDeliverableUrl(url))) return { ok: false, reason: "destination_not_allowed" };

  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, raw] of Object.entries(cfg.headers ?? {})) {
    const value = resolveHeaderValue(raw, deps.env);
    if (value === null) return { ok: false, reason: `unresolved_header:${name}` };
    headers[name] = value;
  }

  let body: string | undefined;
  if (cfg.method === "POST") {
    headers["content-type"] = "application/json";
    body = cfg.body
      ? interpolateJsonBody(cfg.body, ctx)
      : JSON.stringify({
          wa_phone: ctx.contact?.phone ?? null,
          contact_name: ctx.contact?.name ?? null,
          vars: ctx.vars,
        });
  }

  const timeout = Math.min(Math.max(cfg.timeout_ms ?? 8_000, 500), HTTP_FETCH_MAX_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: cfg.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: "http_status", status: response.status };

  const text = await response.text();
  if (text.length > HTTP_FETCH_MAX_RESPONSE_BYTES) return { ok: false, reason: "response_too_large", status: response.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json", status: response.status };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "json_not_object", status: response.status };
  }
  return { ok: true, data: parsed as Record<string, unknown>, status: response.status };
}

// ============================================================
// send_dynamic_choices
// ============================================================

/** Meta's interactive limits. Mirrors INTERACTIVE_LIMITS without importing meta-api into a pure module. */
const BUTTON_TITLE_MAX = 20;
const LIST_ROW_TITLE_MAX = 24;
const LIST_ROW_DESCRIPTION_MAX = 72;
const MAX_BUTTONS = 3;
const MAX_LIST_ROWS = 10;
/** Meta caps interactive reply ids at 200 characters. */
const REPLY_ID_MAX = 200;

const ITEM_PREFIX = "dyn:";
const EXTRA_PREFIX = "x:";

/** Where a node's offered ids are remembered, under `vars`. Namespaced per node. */
export function offerVarKey(nodeKey: string): string {
  return `__offer_${nodeKey}`;
}

export interface DynamicChoiceOption {
  id: string;
  title: string;
  description?: string;
}

export type DynamicChoicesPlan =
  | { kind: "empty" }
  | { kind: "buttons"; options: DynamicChoiceOption[]; offered: string[] }
  | { kind: "list"; options: DynamicChoiceOption[]; offered: string[] };

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Builds the message for a `send_dynamic_choices` node from the run's vars.
 *
 * Three or fewer rows become buttons, which a customer taps without opening
 * a list; more become a list of at most ten. Item ids are prefixed `dyn:` and
 * fixed rows `x:`, so a tap can never be confused between the two, and the
 * item ids are returned as `offered` for the engine to remember - a tap is
 * accepted only for an id this node actually offered in this run.
 */
export function planDynamicChoices(cfg: SendDynamicChoicesNodeConfig, vars: Record<string, unknown>): DynamicChoicesPlan {
  const source = readPath(vars, cfg.source);
  const items = Array.isArray(source) ? source : [];
  const extras = cfg.extra_rows ?? [];
  const itemCapacity = MAX_LIST_ROWS - extras.length;

  const offered: string[] = [];
  const itemOptions: DynamicChoiceOption[] = [];
  for (const item of items) {
    if (itemOptions.length >= itemCapacity) break;
    if (!item || typeof item !== "object") continue;
    const id = stringify(readPath(item, cfg.id_field)).trim();
    const title = stringify(readPath(item, cfg.title_field)).trim();
    if (!id || !title || offered.includes(id)) continue;
    offered.push(id);
    const description = cfg.description_field ? stringify(readPath(item, cfg.description_field)).trim() : "";
    itemOptions.push({
      id: `${ITEM_PREFIX}${id}`.slice(0, REPLY_ID_MAX),
      title,
      ...(description ? { description } : {}),
    });
  }
  if (!itemOptions.length) return { kind: "empty" };

  const extraOptions = extras.map((row) => ({
    id: `${EXTRA_PREFIX}${row.reply_id}`,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
  }));
  const all = [...itemOptions, ...extraOptions];

  if (all.length <= MAX_BUTTONS) {
    return {
      kind: "buttons",
      offered,
      options: all.map((option) => ({ id: option.id, title: clip(option.title, BUTTON_TITLE_MAX) })),
    };
  }
  return {
    kind: "list",
    offered,
    options: all.map((option) => ({
      id: option.id,
      title: clip(option.title, LIST_ROW_TITLE_MAX),
      ...(option.description ? { description: clip(option.description, LIST_ROW_DESCRIPTION_MAX) } : {}),
    })),
  };
}

/** Lowercased letters and digits only, words single-spaced. */
function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Which option a TYPED reply means, for customers who type the option instead
 * of tapping it ("MBBS", "3rd year", "decipher").
 *
 * Matches, in order: the whole title; then a title containing every typed word
 * (3+ letters, or any digit) - but only when exactly one title does, so
 * "cns" with two CNS kits on offer asks again rather than guessing. Returns the
 * option id, or null.
 */
export function matchTypedOption(options: ReadonlyArray<{ id: string; title: string }>, typed: string): string | null {
  const text = normaliseForMatch(typed);
  if (!text || text.length > 60) return null;
  const exact = options.filter((option) => normaliseForMatch(option.title) === text);
  if (exact.length === 1) return exact[0].id;
  const words = text.split(" ").filter((word) => word.length >= 3 || /\d/.test(word));
  if (!words.length) return null;
  const partial = options.filter((option) => {
    const title = normaliseForMatch(option.title);
    return words.every((word) => title.includes(word));
  });
  return partial.length === 1 ? partial[0].id : null;
}

export type DynamicReplyMatch =
  | { kind: "item"; next: string; selection: string }
  | { kind: "extra"; next: string }
  | null;

/** Resolves a tap on a `send_dynamic_choices` message against what this run offered. */
export function matchDynamicReply(
  node: Pick<FlowNodeRow, "node_key" | "config">,
  vars: Record<string, unknown>,
  replyId: string,
): DynamicReplyMatch {
  const cfg = node.config as unknown as SendDynamicChoicesNodeConfig;
  if (replyId.startsWith(EXTRA_PREFIX)) {
    const row = (cfg.extra_rows ?? []).find((extra) => extra.reply_id === replyId.slice(EXTRA_PREFIX.length));
    return row ? { kind: "extra", next: row.next_node_key } : null;
  }
  if (replyId.startsWith(ITEM_PREFIX)) {
    const id = replyId.slice(ITEM_PREFIX.length);
    const offered = vars[offerVarKey(node.node_key)];
    if (Array.isArray(offered) && offered.includes(id)) {
      return { kind: "item", next: cfg.next_node_key, selection: id };
    }
  }
  return null;
}

// ============================================================
// send_products
// ============================================================

/** Meta allows 30 products in a product_list message. */
export const PRODUCT_LIST_MAX = 30;

export function resolveRetailerIds(cfg: SendProductsNodeConfig, vars: Record<string, unknown>): string[] {
  const fromSource = cfg.retailer_ids_source ? readPath(vars, cfg.retailer_ids_source) : undefined;
  const raw = Array.isArray(fromSource) ? fromSource : cfg.retailer_ids ?? [];
  return [...new Set(raw.map((id) => stringify(id).trim()).filter(Boolean))].slice(0, PRODUCT_LIST_MAX);
}

// ============================================================
// Edges - one description consumed by the validator and the canvas
// ============================================================

export interface IntegrationEdge {
  /** Canvas handle id. */
  slot: string;
  label: string;
  /** Config field holding the target; for extra rows, the row index. */
  field: string;
  target: string | undefined;
}

/** Outgoing edges of an integration node, or null for any other node type. */
export function integrationEdges(node: { node_type: string; config: Record<string, unknown> }): IntegrationEdge[] | null {
  const cfg = node.config;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  switch (node.node_type) {
    case "http_fetch":
      return [
        { slot: "success", label: "success", field: "success_next", target: text(cfg.success_next) },
        { slot: "error", label: "error", field: "error_next", target: text(cfg.error_next) },
      ];
    case "send_dynamic_choices": {
      const extras = Array.isArray(cfg.extra_rows) ? (cfg.extra_rows as Array<Record<string, unknown>>) : [];
      return [
        { slot: "next", label: "selected", field: "next_node_key", target: text(cfg.next_node_key) },
        { slot: "empty", label: "empty", field: "empty_next", target: text(cfg.empty_next) },
        ...extras.map((row, index) => ({
          slot: `extra:${text(row.reply_id) ?? index}`,
          label: text(row.title) ?? text(row.reply_id) ?? `extra ${index + 1}`,
          field: `extra_rows.${index}.next_node_key`,
          target: text(row.next_node_key),
        })),
      ];
    }
    case "set_vars":
      return [{ slot: "next", label: "next", field: "next_node_key", target: text(cfg.next_node_key) }];
    case "send_products": {
      const edges: IntegrationEdge[] = [{ slot: "next", label: "next", field: "next_node_key", target: text(cfg.next_node_key) }];
      if (text(cfg.empty_next)) edges.push({ slot: "empty", label: "empty", field: "empty_next", target: text(cfg.empty_next) });
      return edges;
    }
    default:
      return null;
  }
}

/** Returns the config patch that points an integration node's slot at `targetKey`. */
export function applyIntegrationEdge(
  node: { node_type: string; config: Record<string, unknown> },
  slot: string,
  targetKey: string,
): Record<string, unknown> | null {
  const edges = integrationEdges(node);
  const edge = edges?.find((candidate) => candidate.slot === slot);
  if (!edge) return null;
  const match = /^extra_rows\.(\d+)\.next_node_key$/.exec(edge.field);
  if (match) {
    const rows = [...((node.config.extra_rows as Array<Record<string, unknown>>) ?? [])];
    rows[Number(match[1])] = { ...rows[Number(match[1])], next_node_key: targetKey };
    return { extra_rows: rows };
  }
  return { [edge.field]: targetKey };
}

/** Config with every reference to `deletedKey` cleared, or null when there is none. */
export function unlinkIntegrationReferences(
  node: { node_type: string; config: Record<string, unknown> },
  deletedKey: string,
): Record<string, unknown> | null {
  const edges = integrationEdges(node);
  if (!edges?.some((edge) => edge.target === deletedKey)) return null;
  let config = { ...node.config };
  for (const edge of edges) {
    if (edge.target !== deletedKey) continue;
    config = { ...config, ...applyIntegrationEdge({ ...node, config }, edge.slot, "") };
  }
  return config;
}
