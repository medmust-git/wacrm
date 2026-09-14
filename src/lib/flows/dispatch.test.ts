import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Entry-trigger dispatch (issue #490).
//
// Drives the real `dispatchInboundToFlows` against a fake Supabase so
// the assertion is "a run was actually started", not "a helper returned
// true". The bug was that a button tap never reached the keyword
// matcher at all, so a helper-level test would have missed it.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    /** Rows loadActiveRunForContact sees. Empty = no run in progress. */
    activeRuns: [] as unknown[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    /** Set by the flow_runs INSERT; what its .maybeSingle() returns. */
    insertedRun: null as Record<string, unknown> | null,
    rpcCalls: [] as string[],
    /** Rows the conversations lookup sees (the human-handling guard). */
    conversations: [] as unknown[],
    /** What a count of recent agent messages returns. */
    agentMessageCount: 0,
    /** What a count of recent bot handoffs in the conversation returns. */
    recentHandoffCount: 0,
  },
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "conversations") return h.state.conversations;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      filter: () => b,
      // The human-handling guard counts recent agent messages.
      gte: () => b,
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === "flow_runs") {
          h.state.insertedRun = {
            id: "run-1",
            vars: {},
            reprompt_count: 0,
            ...row,
          };
        }
        return b;
      },
      // Only reached on the INSERT ... SELECT for a new run, and on
      // loadFlow's flows lookup.
      maybeSingle: async () => ({
        data:
          table === "flow_runs" ? h.state.insertedRun : (rows(table)[0] ?? null),
        error: null,
      }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: {
          data: unknown[];
          error: null;
          count: number;
        }) => unknown,
      ) =>
        resolve({
          data: rows(table),
          error: null,
          count:
            table === "messages"
              ? h.state.agentMessageCount
              : table === "flow_runs"
                ? h.state.recentHandoffCount
                : 0,
        }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string) => {
        h.state.rpcCalls.push(name);
        return Promise.resolve({ error: null });
      },
    }),
  };
});

const engineSendText = vi.fn(async () => ({ whatsapp_message_id: "wamid.1" }));

vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) =>
    (engineSendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: "wamid.3",
  })),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: "wamid.4",
  })),
}));

import { dispatchInboundToFlows, entryTriggerTexts } from "./engine";
import type { ParsedInbound } from "./types";

const KEYWORD_FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["order status"] },
  entry_node_id: "start",
  created_at: "2026-01-01T00:00:00Z",
};

const NODES = [
  {
    id: "n1",
    flow_id: "flow-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "greet" },
  },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "greet",
    node_type: "send_message",
    config: { text: "Looking that up…", next_node_key: "done" },
  },
  {
    id: "n3",
    flow_id: "flow-1",
    node_key: "done",
    node_type: "end",
    config: {},
  },
];

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });
}

/** flow_runs INSERTs made during a dispatch. */
function startedRuns() {
  return h.state.inserted.filter((i) => i.table === "flow_runs");
}

beforeEach(() => {
  // No run in progress — the whole point is the entry-trigger path.
  h.state.activeRuns = [];
  h.state.flows = [];
  h.state.nodes = NODES;
  h.state.inserted = [];
  h.state.insertedRun = null;
  h.state.rpcCalls = [];
  h.state.conversations = [];
  h.state.agentMessageCount = 0;
  h.state.recentHandoffCount = 0;
  engineSendText.mockClear();
});

describe("entryTriggerTexts", () => {
  it("offers the typed text for a text message", () => {
    expect(
      entryTriggerTexts({
        kind: "text",
        text: "order status",
        meta_message_id: "m1",
      }),
    ).toEqual(["order status"]);
  });

  it("offers both the button title and its reply id", () => {
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "Order status",
        meta_message_id: "m1",
      }),
    ).toEqual(["Order status", "btn_1"]);
  });

  it("drops blanks and collapses a title identical to the id", () => {
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "btn_1",
        meta_message_id: "m1",
      }),
    ).toEqual(["btn_1"]);
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "   ",
        meta_message_id: "m1",
      }),
    ).toEqual(["btn_1"]);
  });
});

describe("dispatchInboundToFlows — entry triggers (#490)", () => {
  it("starts a keyword flow when the customer taps a matching button", async () => {
    h.state.flows = [KEYWORD_FLOW];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "btn_1",
      reply_title: "Order status",
      meta_message_id: "m1",
    });

    // Before the fix this returned {consumed: false, outcome: "no_match"}
    // — the tap was rejected before the keyword matcher ever ran.
    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(
      h.state.inserted.filter((i) => i.table === "flow_runs"),
    ).toHaveLength(1);
    expect(h.state.rpcCalls).toContain("increment_flow_execution_count");
    // The flow really ran, not just got created.
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });

  it("matches on the reply id when the visible title does not", async () => {
    h.state.flows = [
      { ...KEYWORD_FLOW, trigger_config: { keywords: ["order_status"] } },
    ];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "order_status",
      reply_title: "Where is my parcel?",
      meta_message_id: "m1",
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(startedRuns()).toHaveLength(1);
  });

  it("still starts the same flow for the typed text (unchanged path)", async () => {
    h.state.flows = [KEYWORD_FLOW];

    const result = await dispatch({
      kind: "text",
      text: "order status please",
      meta_message_id: "m1",
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(startedRuns()).toHaveLength(1);
  });

  it("leaves a non-matching tap for the automations dispatcher", async () => {
    h.state.flows = [KEYWORD_FLOW];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "btn_9",
      reply_title: "Talk to a human",
      meta_message_id: "m1",
    });

    // consumed:false is what lets the webhook fire the
    // `interactive_reply` automation trigger instead.
    expect(result.consumed).toBe(false);
    expect(result.outcome).toBe("no_match");
    expect(h.state.inserted.filter((i) => i.table === "flow_runs")).toEqual([]);
  });

  it("does not start a manual-trigger flow from a tap", async () => {
    h.state.flows = [{ ...KEYWORD_FLOW, trigger_type: "manual" }];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "btn_1",
      reply_title: "Order status",
      meta_message_id: "m1",
    });

    expect(result.consumed).toBe(false);
  });

  it("starts a first_inbound_message flow when the first inbound is a tap", async () => {
    h.state.flows = [
      {
        ...KEYWORD_FLOW,
        trigger_type: "first_inbound_message",
        trigger_config: {},
      },
    ];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "Yes, tell me more",
        meta_message_id: "m1",
      },
      isFirstInboundMessage: true,
    });

    // A broadcast template's quick-reply button can genuinely be a
    // contact's first-ever inbound; the automations side already
    // treated it that way.
    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(startedRuns()).toHaveLength(1);
  });
});

describe("dispatchInboundToFlows — humans, interrupts and carts", () => {
  const MENU_FLOW = {
    ...KEYWORD_FLOW,
    id: "flow-menu",
    trigger_config: { keywords: ["menu"], match_type: "word", interrupt: true },
  };

  it("does not start a bot run just after it handed the conversation to a person", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.recentHandoffCount = 1;

    const result = await dispatch({ kind: "text", text: "order status?", meta_message_id: "m1" });

    // The customer's next word after a handoff used to restart the menu in
    // the middle of their conversation with staff.
    expect(result.consumed).toBe(false);
    expect(startedRuns()).toEqual([]);
  });

  it("answers again once a pending handoff has gone quiet - it must not ignore the customer forever", async () => {
    h.state.flows = [KEYWORD_FLOW];
    // Pending, but no staff message in the last hour and no recent handoff:
    // the 2026-09-14 case where "Hello", "Hi" and "I need some help" got nothing.
    h.state.conversations = [{ status: "pending" }];
    expect((await dispatch({ kind: "text", text: "order status", meta_message_id: "m1" })).consumed).toBe(true);
  });

  it("does not start a bot run shortly after an agent has written", async () => {
    h.state.flows = [KEYWORD_FLOW];
    h.state.conversations = [{ status: "open" }];
    h.state.agentMessageCount = 1;

    expect((await dispatch({ kind: "text", text: "order status", meta_message_id: "m1" })).consumed).toBe(false);
  });

  it("still starts an interrupt flow the customer asks for by name", async () => {
    h.state.flows = [MENU_FLOW];
    h.state.agentMessageCount = 1;

    const result = await dispatch({ kind: "text", text: "menu", meta_message_id: "m1" });

    expect(result.consumed).toBe(true);
    expect(startedRuns()[0]?.row.flow_id).toBe("flow-menu");
  });

  it("matches an interrupt keyword as a whole word only", async () => {
    h.state.flows = [MENU_FLOW];
    expect((await dispatch({ kind: "text", text: "menuscript", meta_message_id: "m1" })).consumed).toBe(false);
  });

  it("ends the active run and starts the interrupt flow mid-conversation", async () => {
    h.state.activeRuns = [
      {
        id: "old-run",
        flow_id: "flow-track",
        account_id: "acct-1",
        user_id: "u-1",
        contact_id: "ct-1",
        conversation_id: "cv-1",
        status: "active",
        current_node_key: "ask_order_number",
        vars: {},
        reprompt_count: 0,
      },
    ];
    h.state.flows = [MENU_FLOW];

    const result = await dispatch({ kind: "text", text: "Menu", meta_message_id: "m2" });

    expect(result.consumed).toBe(true);
    expect(startedRuns()).toHaveLength(1);
    expect(startedRuns()[0].row.flow_id).toBe("flow-menu");
  });

  it("starts the order flow for a catalogue cart, with the cart in vars", async () => {
    h.state.flows = [KEYWORD_FLOW, { ...KEYWORD_FLOW, id: "flow-cart", trigger_type: "order_message", trigger_config: {} }];
    const items = [{ product_retailer_id: "decipher-i", quantity: 2, item_price: 239, currency: "INR" }];

    const result = await dispatch({ kind: "order", catalog_id: "cat-1", items, meta_message_id: "m3" });

    expect(result.consumed).toBe(true);
    expect(startedRuns()).toHaveLength(1);
    expect(startedRuns()[0].row.flow_id).toBe("flow-cart");
    expect(startedRuns()[0].row.vars).toEqual({ cart: items, catalog_id: "cat-1" });
  });

  it("seeds the lowercased trigger text so a condition can route by intent", async () => {
    h.state.flows = [KEYWORD_FLOW];
    await dispatch({ kind: "text", text: "Order STATUS please", meta_message_id: "m5" });
    expect(startedRuns()[0].row.vars).toEqual({ trigger_text: "order status please" });
  });

  describe("interrupt_keywords", () => {
    const CARE_FLOW = {
      ...KEYWORD_FLOW,
      id: "flow-care",
      trigger_config: { keywords: ["order", "menu"], match_type: "word", interrupt_keywords: ["menu"] },
    };
    const RUNNING = {
      id: "old-run",
      flow_id: "flow-care",
      account_id: "acct-1",
      user_id: "u-1",
      contact_id: "ct-1",
      conversation_id: "cv-1",
      status: "active",
      current_node_key: "greet",
      vars: {},
      reprompt_count: 0,
    };

    it("does not restart the flow when a non-interrupt keyword is typed mid-run", async () => {
      h.state.activeRuns = [RUNNING];
      h.state.flows = [CARE_FLOW];
      await dispatch({ kind: "text", text: "my order", meta_message_id: "m6" });
      expect(startedRuns()).toEqual([]);
    });

    it("restarts it on an interrupt keyword", async () => {
      h.state.activeRuns = [RUNNING];
      h.state.flows = [CARE_FLOW];
      await dispatch({ kind: "text", text: "menu", meta_message_id: "m7" });
      expect(startedRuns()).toHaveLength(1);
    });

    it("lets only the interrupt keyword through while a person is handling the chat", async () => {
      h.state.flows = [CARE_FLOW];
      h.state.agentMessageCount = 1;
      expect((await dispatch({ kind: "text", text: "order", meta_message_id: "m8" })).consumed).toBe(false);
      expect((await dispatch({ kind: "text", text: "menu", meta_message_id: "m9" })).consumed).toBe(true);
    });
  });

  describe("options-only bot", () => {
    const CATCH_ALL_FLOW = {
      ...KEYWORD_FLOW,
      id: "flow-care",
      trigger_config: { keywords: ["menu"], match_type: "word", catch_all: true },
    };
    const BUTTON_NODES = [
      ...NODES,
      {
        id: "n4",
        flow_id: "flow-care",
        node_key: "pick",
        node_type: "send_buttons",
        config: {
          text: "Which one?",
          buttons: [{ reply_id: "a", title: "Option A", next_node_key: "done" }],
        },
      },
    ];
    const WAITING = {
      id: "old-run",
      flow_id: "flow-care",
      account_id: "acct-1",
      user_id: "u-1",
      contact_id: "ct-1",
      conversation_id: "cv-1",
      status: "active",
      current_node_key: "pick",
      vars: {},
    };

    it("starts the catch-all flow for text no keyword matched", async () => {
      h.state.flows = [KEYWORD_FLOW, CATCH_ALL_FLOW];
      const result = await dispatch({ kind: "text", text: "ok thanks", meta_message_id: "c1" });
      expect(result.consumed).toBe(true);
      expect(startedRuns()[0].row.flow_id).toBe("flow-care");
    });

    it("lets a real keyword win over the catch-all", async () => {
      h.state.flows = [CATCH_ALL_FLOW, KEYWORD_FLOW];
      await dispatch({ kind: "text", text: "order status", meta_message_id: "c2" });
      expect(startedRuns()[0].row.flow_id).toBe("flow-1");
    });

    it("does not talk over staff", async () => {
      h.state.flows = [CATCH_ALL_FLOW];
      h.state.agentMessageCount = 1;
      expect((await dispatch({ kind: "text", text: "ok thanks", meta_message_id: "c3" })).consumed).toBe(false);
    });

    it("does not answer a cart", async () => {
      h.state.flows = [CATCH_ALL_FLOW];
      expect((await dispatch({ kind: "order", catalog_id: null, items: [], meta_message_id: "c4" })).consumed).toBe(false);
    });

    it("says to tap an option before re-asking", async () => {
      h.state.flows = [{ ...CATCH_ALL_FLOW, fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 1, on_timeout_hours: 2, on_exhaust: "restart", reprompt_text: "Please tap an option." } }];
      h.state.nodes = BUTTON_NODES;
      h.state.activeRuns = [{ ...WAITING, reprompt_count: 0 }];

      const result = await dispatch({ kind: "text", text: "what?", meta_message_id: "c5" });

      expect(result.outcome).toBe("fallback_fired");
      expect(engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: "Please tap an option." }));
      expect(startedRuns()).toEqual([]);
    });

    it("takes a typed option name as the tap, so a customer typing 'Decipher' is not told off", async () => {
      h.state.flows = [CATCH_ALL_FLOW];
      h.state.nodes = [
        ...NODES,
        {
          id: "n5",
          flow_id: "flow-care",
          node_key: "pick_product",
          node_type: "send_dynamic_choices",
          config: {
            text: "Pick one",
            button_label: "Products",
            source: "prods.choices",
            id_field: "id",
            title_field: "title",
            save_selection_as: "product_id",
            next_node_key: "done",
            empty_next: "done",
          },
        },
      ];
      h.state.activeRuns = [
        {
          ...WAITING,
          current_node_key: "pick_product",
          reprompt_count: 0,
          vars: {
            prods: { choices: [{ id: "decipher-iii", title: "DECIPHER III KUHS: Third" }, { id: "cns-kit", title: "CNS kit" }] },
            __offer_pick_product: ["decipher-iii", "cns-kit"],
          },
        },
      ];

      const result = await dispatch({ kind: "text", text: "Decipher", meta_message_id: "c7" });

      expect(result.outcome).not.toBe("fallback_fired");
      expect(engineSendText).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("tap") }));
    });

    it("restarts the flow from its entry instead of handing off once reprompts run out", async () => {
      h.state.flows = [{ ...CATCH_ALL_FLOW, fallback_policy: { on_unknown_reply: "reprompt", max_reprompts: 1, on_timeout_hours: 2, on_exhaust: "restart" } }];
      h.state.nodes = BUTTON_NODES;
      h.state.activeRuns = [{ ...WAITING, reprompt_count: 1 }];

      const result = await dispatch({ kind: "text", text: "Track my order", meta_message_id: "c6" });

      expect(result.consumed).toBe(true);
      expect(startedRuns()).toHaveLength(1);
      expect(startedRuns()[0].row).toMatchObject({ flow_id: "flow-care", vars: { trigger_text: "track my order" } });
    });
  });

  describe("friendlier entry: media, small talk and greeting context", () => {
    const MEDIA_FLOW = { ...KEYWORD_FLOW, id: "flow-media", trigger_config: { keywords: ["voice note"], match_type: "exact", on_media: true } };
    const THANKS_FLOW = {
      ...KEYWORD_FLOW,
      id: "flow-thanks",
      trigger_config: { keywords: ["thanks", "ok"], match_type: "exact", interrupt_keywords: ["thanks"], quiet_when_human: true },
    };

    it("starts the media flow for a voice note, with the kind in vars", async () => {
      h.state.flows = [KEYWORD_FLOW, MEDIA_FLOW];
      const result = await dispatch({ kind: "media", media_type: "audio", meta_message_id: "d1" });
      expect(result.consumed).toBe(true);
      expect(startedRuns()[0].row).toMatchObject({ flow_id: "flow-media", vars: { media_type: "audio" } });
    });

    it("leaves media alone when no flow asked for it", async () => {
      h.state.flows = [{ ...KEYWORD_FLOW, trigger_config: { keywords: ["x"], catch_all: true } }];
      expect((await dispatch({ kind: "media", media_type: "image", meta_message_id: "d2" })).consumed).toBe(false);
    });

    it("does not answer a photo sent to staff", async () => {
      h.state.flows = [MEDIA_FLOW];
      h.state.agentMessageCount = 1;
      expect((await dispatch({ kind: "media", media_type: "image", meta_message_id: "d3" })).consumed).toBe(false);
    });

    it("matches an exact keyword despite trailing punctuation", async () => {
      h.state.flows = [THANKS_FLOW];
      expect((await dispatch({ kind: "text", text: "Thanks!!", meta_message_id: "d4" })).consumed).toBe(true);
    });

    it("keeps a quiet_when_human interrupt from answering a customer thanking staff", async () => {
      h.state.flows = [THANKS_FLOW];
      h.state.agentMessageCount = 1;
      expect((await dispatch({ kind: "text", text: "thanks", meta_message_id: "d5" })).consumed).toBe(false);
    });
  });

  it("never starts a keyword flow from a cart", async () => {
    h.state.flows = [{ ...KEYWORD_FLOW, trigger_config: { keywords: ["order"] } }];
    const result = await dispatch({ kind: "order", catalog_id: null, items: [], meta_message_id: "m4" });
    expect(result.consumed).toBe(false);
  });
});
