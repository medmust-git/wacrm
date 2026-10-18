import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / Referrer-Policy: baseline OWASP
 *     hardening, no behavioural cost. X-Frame-Options is deliberately
 *     NOT here — see FRAME_ANCESTORS below.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 */
/**
 * Origins allowed to embed wacrm in an iframe.
 *
 * The MedMust admin workspace renders the wacrm inbox in-place at
 * /admin/customers/support. `crm.medmust.in` and `medmust.in` share a
 * registrable domain, so that frame is same-site: Supabase's SameSite=Lax
 * session cookies flow into it normally and none of third-party cookie
 * blocking, Chrome storage partitioning or Safari ITP applies. Do NOT
 * "fix" an embed problem by setting SameSite=None — it is not needed here
 * and would weaken the cookie for no gain.
 *
 * X-Frame-Options cannot express an allow-list (ALLOW-FROM is dead in
 * every current browser), so it is deliberately absent and this list,
 * shipped as an ENFORCING `frame-ancestors`, is the clickjacking control.
 * Keep those two facts together: re-adding X-Frame-Options: DENY silently
 * breaks the embed, because it wins over frame-ancestors in every browser
 * that honours it.
 */
const FRAME_ANCESTORS = [
  "'self'",
  "https://medmust.in",
  // MedMust's staging backend, so the embed can be proven before production.
  "https://medmust-web--medmust-dev.asia-east1.hosted.app",
  // Local MedMust dev server pointing at the deployed CRM.
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].join(" ");

const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder. Everything
    // else stays denied — a compromised dependency can't silently grab
    // the camera / geolocation / etc.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js needs 'unsafe-inline' for its inline hydration script
      // and 'unsafe-eval' in dev + some production optimisations.
      // Nonce-based CSP is a later project.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + inline style attributes on lots of components.
      "style-src 'self' 'unsafe-inline'",
      // Supabase public-bucket avatars, contact avatars (arbitrary
      // https URLs paste-able from the UI), OG images, data URLs for
      // tiny inline assets.
      "img-src 'self' data: blob: https:",
      // Outbound media previews (blob: from MediaRecorder + file picker)
      // and Supabase public-bucket audio/video the inbox renders.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // Supabase REST + realtime (WSS). All Meta API calls happen
      // server-side, so graph.facebook.com does not belong here.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      `frame-ancestors ${FRAME_ANCESTORS}`,
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
  {
    /*
     * The policy above is report-only and therefore blocks NOTHING, its
     * frame-ancestors included. This second, enforcing header carries the
     * framing rule alone — the only directive we are confident enough to
     * enforce today. Two CSP headers legally coexist: the browser enforces
     * this one and reports violations of the other.
     */
    key: "Content-Security-Policy",
    value: `frame-ancestors ${FRAME_ANCESTORS}`,
  },
] as const;

const APP_LOCALE = ["en", "pt", "es", "ko"].includes(process.env.NEXT_PUBLIC_APP_LOCALE ?? "")
  ? (process.env.NEXT_PUBLIC_APP_LOCALE as string)
  : "en";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      "@app-messages": `./messages/${APP_LOCALE}.json`,
    },
  },
  // Emit a self-contained server bundle (.next/standalone) so the
  // Docker image can run without node_modules or the Next CLI.
  // Harmless outside Docker: `next start` keeps working as before.
  output: "standalone",
  experimental: {
    turbopackPluginRuntimeStrategy: "workerThreads",
  },
  // Stop `next dev` from overwriting the repo's hand-written AGENTS.md.
  agentRules: false,

  /**
   * Cross-origin dev access (Next.js 16).
   *
   * Next 16 blocks requests to dev-only resources (`/_next/*` internals,
   * the HMR websocket, the dev overlay) unless the browser's Origin is
   * the host the dev server booted on — `localhost` by default. Tunnels
   * like ngrok serve the app from a public HTTPS host, so without
   * allow-listing that host those dev requests come back 403: HMR stops
   * working and the dev session degrades over the tunnel (issue #365).
   *
   * Wildcards match subdomains only (Next's CSRF matcher), so the
   * randomised tunnel subdomain is covered. Add any other host via
   * `ALLOWED_DEV_ORIGINS` (comma-separated). This key is dev-only and
   * has no effect on a production build.
   */
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
    "*.loca.lt",
    ...(process.env.ALLOWED_DEV_ORIGINS
      ? process.env.ALLOWED_DEV_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ],

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path((?!_next/static|_next/image|api).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "private, no-store",
          },
        ],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
