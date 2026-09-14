import { describe, expect, it, vi } from "vitest";
import {
  applyIntegrationEdge,
  executeHttpFetch,
  firstName,
  integrationEdges,
  interpolateJsonBody,
  interpolateTemplate,
  interpolateUrl,
  matchDynamicReply,
  matchTypedOption,
  offerVarKey,
  planDynamicChoices,
  readPath,
  resolveHeaderValue,
  resolveRetailerIds,
  unlinkIntegrationReferences,
  type HttpFetchNodeConfig,
  type SendDynamicChoicesNodeConfig,
} from "./integrations";

describe("placeholders", () => {
  const ctx = {
    vars: { order: { awb: "D123", lines: [{ name: "Decipher" }] }, name: "Anjali" },
    contact: { phone: "916235255666", name: "Anjali K" },
  };

  it("reads dotted paths and array indexes", () => {
    expect(readPath(ctx.vars, "order.lines.0.name")).toBe("Decipher");
    expect(readPath(ctx.vars, "order.missing.deep")).toBeUndefined();
  });

  it("fills nested vars and contact fields, and keeps the old flat form working", () => {
    expect(interpolateTemplate("AWB {{vars.order.awb}} for {{contact.name}} ({{vars.name}})", ctx)).toBe("AWB D123 for Anjali K (Anjali)");
    expect(interpolateTemplate("missing: [{{vars.nope}}]", ctx)).toBe("missing: []");
  });

  it("URL-encodes values in URLs", () => {
    expect(interpolateUrl("https://x.test/?q={{vars.q}}", { vars: { q: "a b&c" } })).toBe("https://x.test/?q=a%20b%26c");
  });

  it("escapes a customer's quote inside a JSON body instead of letting it add fields", () => {
    const body = interpolateJsonBody('{"order_number":"{{vars.typed}}","admin":false}', { vars: { typed: '","admin":true,"x":"' } });
    expect(JSON.parse(body)).toEqual({ order_number: '","admin":true,"x":"', admin: false });
  });

  it("inserts raw JSON with the json: prefix", () => {
    expect(JSON.parse(interpolateJsonBody('{"items":{{json:vars.cart}}}', { vars: { cart: [{ id: "a", quantity: 2 }] } }))).toEqual({ items: [{ id: "a", quantity: 2 }] });
  });
});

describe("resolveHeaderValue", () => {
  const env = { FLOW_SECRET_BOT: "s3cret", SUPABASE_SERVICE_ROLE_KEY: "never" };

  it("resolves only FLOW_SECRET_* names", () => {
    expect(resolveHeaderValue("{{env.FLOW_SECRET_BOT}}", env)).toBe("s3cret");
    expect(resolveHeaderValue("{{env.SUPABASE_SERVICE_ROLE_KEY}}", env)).toBeNull();
    expect(resolveHeaderValue("prefix {{env.FLOW_SECRET_BOT}}", env)).toBeNull();
  });

  it("refuses an unset secret instead of sending an empty credential", () => {
    expect(resolveHeaderValue("{{env.FLOW_SECRET_MISSING}}", env)).toBeNull();
  });

  it("passes a plain value through", () => {
    expect(resolveHeaderValue("application/json", env)).toBe("application/json");
  });
});

describe("executeHttpFetch", () => {
  const cfg: HttpFetchNodeConfig = {
    method: "POST",
    url: "https://medmust.in/api/whatsapp-bot/orders/active",
    headers: { "x-bot-secret": "{{env.FLOW_SECRET_BOT}}" },
    save_as: "orders",
    success_next: "ok",
    error_next: "err",
  };
  const ctx = { vars: {}, contact: { phone: "916235255666", name: "A" } };
  const deps = (response: Response | Error, deliverable = true) => ({
    env: { FLOW_SECRET_BOT: "s3cret" },
    isDeliverableUrl: vi.fn(async () => deliverable),
    fetch: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }) as unknown as typeof fetch,
  });

  it("sends the secret and the default body, and returns the parsed object", async () => {
    const d = deps(new Response(JSON.stringify({ result: "found", count: 2 }), { status: 200 }));
    const outcome = await executeHttpFetch(cfg, ctx, d);
    expect(outcome).toEqual({ ok: true, status: 200, data: { result: "found", count: 2 } });
    const [, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["x-bot-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual({ wa_phone: "916235255666", contact_name: "A", vars: {} });
    expect(init.redirect).toBe("manual");
  });

  it("refuses a private destination before making any request", async () => {
    const d = deps(new Response("{}"), false);
    expect(await executeHttpFetch(cfg, ctx, d)).toEqual({ ok: false, reason: "destination_not_allowed" });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("refuses to send with an unresolved secret", async () => {
    const d = { ...deps(new Response("{}")), env: {} };
    expect((await executeHttpFetch(cfg, ctx, d)).ok).toBe(false);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-2xx status", new Response("{}", { status: 500 })],
    ["invalid JSON", new Response("<html>", { status: 200 })],
    ["a JSON array", new Response("[]", { status: 200 })],
  ])("takes the error branch on %s", async (_label, response) => {
    expect((await executeHttpFetch(cfg, ctx, deps(response))).ok).toBe(false);
  });

  it("takes the error branch on a network failure", async () => {
    expect((await executeHttpFetch(cfg, ctx, deps(new Error("boom")))).ok).toBe(false);
  });
});

describe("send_dynamic_choices", () => {
  const cfg: SendDynamicChoicesNodeConfig = {
    text: "Which order?",
    button_label: "Choose",
    source: "orders.choices",
    id_field: "id",
    title_field: "title",
    description_field: "description",
    save_selection_as: "order_id",
    next_node_key: "detail",
    empty_next: "none",
  };
  const choices = (n: number) => ({ orders: { choices: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, title: `#KL-2026-1000${i}`, description: "Shipped" })) } });

  it("is empty when the source is missing or has nothing usable", () => {
    expect(planDynamicChoices(cfg, {})).toEqual({ kind: "empty" });
    expect(planDynamicChoices(cfg, { orders: { choices: [{ id: "", title: "x" }] } })).toEqual({ kind: "empty" });
  });

  it("uses buttons for up to three options and a list beyond", () => {
    expect(planDynamicChoices(cfg, choices(3)).kind).toBe("buttons");
    const list = planDynamicChoices(cfg, choices(4));
    expect(list.kind).toBe("list");
  });

  it("caps a list at ten rows including fixed extra rows", () => {
    const plan = planDynamicChoices({ ...cfg, extra_rows: [{ reply_id: "other", title: "Something else", next_node_key: "human" }] }, choices(15));
    if (plan.kind !== "list") throw new Error("expected a list");
    expect(plan.options).toHaveLength(10);
    expect(plan.offered).toHaveLength(9);
    expect(plan.options.at(-1)?.id).toBe("x:other");
  });

  it("truncates titles to Meta's limits", () => {
    const plan = planDynamicChoices(cfg, { orders: { choices: [{ id: "a", title: "A title that is much longer than twenty" }] } });
    if (plan.kind !== "buttons") throw new Error("expected buttons");
    expect(plan.options[0].title.length).toBeLessThanOrEqual(20);
  });

  it("accepts a tap only for an id this run offered", () => {
    const node = { node_key: "pick", config: cfg as unknown as Record<string, unknown> };
    const vars = { [offerVarKey("pick")]: ["o1", "o2"] };
    expect(matchDynamicReply(node, vars, "dyn:o1")).toEqual({ kind: "item", next: "detail", selection: "o1" });
    expect(matchDynamicReply(node, vars, "dyn:someone_elses_order")).toBeNull();
  });

  it("routes a fixed extra row to its own node", () => {
    const withExtra = { ...cfg, extra_rows: [{ reply_id: "menu", title: "Main menu", next_node_key: "menu" }] };
    expect(matchDynamicReply({ node_key: "pick", config: withExtra as unknown as Record<string, unknown> }, {}, "x:menu")).toEqual({ kind: "extra", next: "menu" });
  });
});

describe("resolveRetailerIds", () => {
  it("prefers the source, de-duplicates and caps at 30", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `p${i % 35}`);
    const resolved = resolveRetailerIds({ mode: "product_list", body_text: "x", next_node_key: "n", retailer_ids_source: "catalog.ids", retailer_ids: ["static"] }, { catalog: { ids } });
    expect(resolved).toHaveLength(30);
    expect(new Set(resolved).size).toBe(30);
    expect(resolved).not.toContain("static");
  });
});

describe("integration edges", () => {
  const node = {
    node_type: "send_dynamic_choices",
    config: { next_node_key: "a", empty_next: "b", extra_rows: [{ reply_id: "menu", title: "Menu", next_node_key: "c" }] },
  };

  it("lists every outgoing slot", () => {
    expect(integrationEdges(node)?.map((edge) => `${edge.slot}->${edge.target}`)).toEqual(["next->a", "empty->b", "extra:menu->c"]);
    expect(integrationEdges({ node_type: "send_message", config: {} })).toBeNull();
  });

  it("connects and unlinks an extra row without touching the others", () => {
    expect(applyIntegrationEdge(node, "extra:menu", "z")).toEqual({ extra_rows: [{ reply_id: "menu", title: "Menu", next_node_key: "z" }] });
    const unlinked = unlinkIntegrationReferences(node, "c");
    expect(unlinked?.next_node_key).toBe("a");
    expect((unlinked?.extra_rows as Array<{ next_node_key: string }>)[0].next_node_key).toBe("");
    expect(unlinkIntegrationReferences(node, "nothing")).toBeNull();
  });
});

describe("friendly personalisation and typed replies", () => {
  it("greets by first name, skipping titles and non-names, with a fallback", () => {
    expect(firstName("Dr. ANJALI Menon")).toBe("Anjali");
    expect(firstName("Rahul K")).toBe("Rahul");
    expect(firstName("919876543210")).toBeUndefined();
    expect(firstName("~ 🌸")).toBeUndefined();
    const ctx = { vars: {}, contact: { phone: "+91", name: "919876543210" } };
    expect(interpolateTemplate("Hi {{contact.first_name|there}}!", ctx)).toBe("Hi there!");
    expect(interpolateTemplate("Hi {{contact.first_name|there}}!", { vars: {}, contact: { phone: null, name: "meera" } })).toBe("Hi Meera!");
    expect(interpolateTemplate("{{vars.missing | none}}", { vars: {} })).toBe("none");
  });

  it("matches a typed reply to exactly one option", () => {
    const options = [
      { id: "a", title: "DECIPHER III KUHS: Third" },
      { id: "b", title: "CNS kit - Personalized" },
      { id: "c", title: "CNS Kit Plus" },
      { id: "d", title: "3rd year" },
    ];
    expect(matchTypedOption(options, "Decipher")).toBe("a");
    expect(matchTypedOption(options, "cns kit plus")).toBe("c");
    expect(matchTypedOption(options, "CNS")).toBeNull();
    expect(matchTypedOption(options, "3")).toBe("d");
    expect(matchTypedOption(options, "ok")).toBeNull();
    expect(matchTypedOption([{ id: "q1", title: "1" }, { id: "q2", title: "2" }], "2")).toBe("q2");
  });
});
