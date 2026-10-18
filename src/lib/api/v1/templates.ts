// ============================================================
// Public API (v1) serializer for message templates.
//
// The dashboard's `message_templates` row carries submission
// plumbing — `user_id`, `account_id`, `meta_template_id`,
// `submission_error`, `last_submitted_at` — that an integration has
// no use for and that shouldn't leak onto the public wire. This
// projects the subset a caller needs to SEND a template: its name,
// language, and the variables it expects.
// ============================================================

export interface ApiTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  body_text: string;
  header_type: string | null;
  footer_text: string | null;
  buttons: unknown;
  /**
   * Meta's example values, `{ body: string[], header: string[] }`.
   *
   * The only machine-readable signal for HOW MANY positional body
   * variables a template takes — the count of `sample_values.body`.
   * `body_text` carries them as `{{1}}`, `{{2}}` …, which a caller
   * would otherwise have to parse out of prose.
   */
  sample_values: unknown;
  quality_score: string | null;
  created_at: string;
  updated_at: string;
}

interface TemplateRow {
  id: string;
  name: string;
  language: string | null;
  category: string | null;
  status: string | null;
  body_text: string | null;
  header_type: string | null;
  footer_text: string | null;
  buttons: unknown;
  sample_values: unknown;
  quality_score: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Columns the serializer needs — never `select('*')` on the wire path. */
export const TEMPLATE_SELECT =
  'id, name, language, category, status, body_text, header_type, footer_text, buttons, sample_values, quality_score, created_at, updated_at';

export function serializeTemplate(row: TemplateRow): ApiTemplate {
  return {
    id: row.id,
    name: row.name,
    // `language` defaults to en_US in the schema but is nullable on the
    // column; a send needs one, so the default is restated rather than
    // handed out as null.
    language: row.language ?? 'en_US',
    category: row.category ?? 'Marketing',
    status: row.status ?? 'DRAFT',
    body_text: row.body_text ?? '',
    header_type: row.header_type ?? null,
    footer_text: row.footer_text ?? null,
    buttons: row.buttons ?? null,
    sample_values: row.sample_values ?? null,
    quality_score: row.quality_score ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  };
}
