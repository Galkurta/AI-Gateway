import "dotenv/config";
import "express-async-errors";
import { randomUUID } from "crypto";
import express from "express";
import cors from "cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openaiRouter } from "./routes/openai.js";
import { anthropicRouter } from "./routes/anthropic.js";
import { adminRouter } from "./routes/admin.js";
import { oauthAdminRouter, oauthPublicRouter } from "./routes/oauth.js";
import { requireGatewayKey, requireAdminPassword } from "./middleware/auth.js";
import { db, type ProviderAccount } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// ─── Middleware ────────────────────────────────────────────────────────────────

const corsOrigins = process.env.CORS_ORIGINS ?? "*";
app.use(
  cors({
    origin:
      corsOrigins === "*" ? true : corsOrigins.split(",").map((s) => s.trim()),
    credentials: true,
  }),
);

app.use(express.json({ limit: process.env.MAX_BODY_SIZE ?? "10mb" }));

// ─── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// ─── API routes ────────────────────────────────────────────────────────────────

// OpenAI-compatible (no anthropic-version header needed)
app.use("/v1", requireGatewayKey, openaiRouter);

// Anthropic-compatible (clients that set anthropic-version header)
// Also mounted at /anthropic/v1 for explicit targeting
app.use("/anthropic/v1", requireGatewayKey, anthropicRouter);

// Admin API (protected by admin password)
app.use("/api/oauth", requireAdminPassword, oauthAdminRouter);
app.use("/api", requireAdminPassword, adminRouter);

// OAuth callback routes cannot require custom headers because providers redirect here.
app.use("/oauth", oauthPublicRouter);
app.use("/", oauthPublicRouter);

function extensionAuthorized(req: express.Request, res: express.Response): boolean {
  const token = req.headers["x-extension-token"] as string | undefined;
  const extToken = process.env.EXTENSION_TOKEN ?? "ext-token-change-me";
  if (token !== extToken) {
    res.status(401).json({ error: "Invalid extension token" });
    return false;
  }
  return true;
}

function parseRecord(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

function mergeWebCookieHeaders(type: string, cookies: Record<string, string>, baseHeaders: Record<string, string>): Record<string, string> {
  const extraHeaders = { ...baseHeaders };
  if (type === "bud-web") {
    if (cookies.bud_projectid) extraHeaders["X-Bud-ProjectId"] = cookies.bud_projectid;
    if (cookies.bud_userid) extraHeaders["X-Bud-UserId"] = cookies.bud_userid;
    if (cookies.bud_chatsessionid) extraHeaders["X-Bud-ChatSessionId"] = cookies.bud_chatsessionid;
    if (cookies.bud_template) extraHeaders["X-Bud-Template"] = cookies.bud_template;
  }
  if (type === "devin-web") {
    if (cookies.devin_orgid) extraHeaders["X-Devin-OrgId"] = cookies.devin_orgid;
    if (cookies.devin_userid) extraHeaders["X-Devin-UserId"] = cookies.devin_userid;
    if (cookies.devin_username) extraHeaders["X-Devin-Username"] = cookies.devin_username;
  }
  return extraHeaders;
}

function inferCookieAccountName(type: string, cookies: Record<string, string>): string | undefined {
  if (type === "bud-web") {
    const user = cookies.bud_userid;
    const project = cookies.bud_projectid;
    if (user && project) return `Bud ${user} ${project.slice(0, 8)}`;
    if (user) return `Bud ${user}`;
    if (project) return `Bud ${project.slice(0, 8)}`;
  }
  if (type === "devin-web") {
    if (cookies.devin_username && cookies.devin_orgid) return `Devin ${cookies.devin_username} ${cookies.devin_orgid.slice(0, 12)}`;
    if (cookies.devin_orgname) return `Devin ${cookies.devin_orgname}`;
    if (cookies.devin_orgid) return `Devin ${cookies.devin_orgid.slice(0, 12)}`;
  }
  return undefined;
}

app.get("/ext/providers/:providerId/accounts", (req, res) => {
  if (!extensionAuthorized(req, res)) return;
  const rows = db.prepare(`
    SELECT id, provider_id, name, auth_type, enabled, priority, requests_count, error_count, last_used_at, last_error_at, cooldown_until, created_at, updated_at
    FROM provider_accounts
    WHERE provider_id = ?
    ORDER BY priority DESC, created_at ASC
  `).all(req.params.providerId);
  res.json(rows);
});

app.post("/ext/cookies/:providerId", (req, res) => {
  if (!extensionAuthorized(req, res)) return;
  const { cookies, account_id, account_name } = req.body as {
    cookies: Record<string, string>;
    account_id?: string;
    account_name?: string;
  };
  if (!cookies) {
    res.status(400).json({ error: "cookies required" });
    return;
  }

  const p = db
    .prepare("SELECT id, type, cookies, extra_headers FROM providers WHERE id = ?")
    .get(req.params.providerId) as { id: string; type: string; cookies: string | null; extra_headers: string | null } | undefined;
  if (!p) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  const inferredName = account_name?.trim() || inferCookieAccountName(p.type, cookies);
  const now = Date.now();
  if (account_id || inferredName) {
    const existing = account_id
      ? db.prepare("SELECT * FROM provider_accounts WHERE id = ? AND provider_id = ?").get(account_id, p.id) as ProviderAccount | undefined
      : undefined;
    if (account_id && !existing) {
      res.status(404).json({ error: "Account not found" });
      return;
    }

    const mergedCookies = { ...parseRecord(existing?.cookies ?? p.cookies), ...cookies };
    const extraHeaders = mergeWebCookieHeaders(p.type, mergedCookies, parseRecord(existing?.extra_headers ?? p.extra_headers));
    const id = existing?.id ?? randomUUID();
    const name = existing?.name ?? inferredName ?? "Cookie Account";
    db.prepare(`
      INSERT INTO provider_accounts
        (id, provider_id, name, auth_type, cookies, extra_headers, enabled, priority, created_at, updated_at)
      VALUES (?, ?, ?, 'cookies', ?, ?, 1, 0, ?, ?)
      ON CONFLICT(provider_id, name) DO UPDATE SET
        auth_type = 'cookies',
        cookies = excluded.cookies,
        extra_headers = excluded.extra_headers,
        enabled = 1,
        updated_at = excluded.updated_at
    `).run(
      id,
      p.id,
      name,
      JSON.stringify(mergedCookies),
      Object.keys(extraHeaders).length ? JSON.stringify(extraHeaders) : null,
      now,
      now,
    );
    db.prepare("UPDATE providers SET enabled = 1, updated_at = ? WHERE id = ?").run(now, p.id);
    res.json({ ok: true, account: name });
    return;
  }

  const mergedCookies = { ...parseRecord(p.cookies), ...cookies };
  const extraHeaders = mergeWebCookieHeaders(p.type, mergedCookies, parseRecord(p.extra_headers));
  db.prepare(
    "UPDATE providers SET cookies = ?, extra_headers = ?, updated_at = ? WHERE id = ?",
  ).run(
    JSON.stringify(mergedCookies),
    Object.keys(extraHeaders).length ? JSON.stringify(extraHeaders) : p.extra_headers,
    now,
    req.params.providerId,
  );
  res.json({ ok: true });
});

// Chrome extension CORS-free cookie push endpoint
app.post("/ext/cookies/:providerId", (req, res) => {
  // Extension uses its own simple token from env
  const token = req.headers["x-extension-token"] as string | undefined;
  const extToken = process.env.EXTENSION_TOKEN ?? "ext-token-change-me";
  if (token !== extToken) {
    res.status(401).json({ error: "Invalid extension token" });
    return;
  }
  // Delegate to admin route handler logic inline
  const { cookies } = req.body as { cookies: Record<string, string> };
  if (!cookies) {
    res.status(400).json({ error: "cookies required" });
    return;
  }

  // Dynamic import to avoid circular — just use db directly
  import("./db/index.js").then(({ db }) => {
    const p = db
      .prepare("SELECT id, type, cookies, extra_headers FROM providers WHERE id = ?")
      .get(req.params.providerId) as { id: string; type: string; cookies: string | null; extra_headers: string | null } | undefined;
    if (!p) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const existingCookies = parseRecord(p.cookies);
    const mergedCookies = { ...existingCookies, ...cookies };
    const extraHeaders = (() => {
      try {
        return p.extra_headers ? JSON.parse(p.extra_headers) as Record<string, string> : {};
      } catch {
        return {};
      }
    })();
    if (p.type === "bud-web") {
      if (mergedCookies.bud_projectid) extraHeaders["X-Bud-ProjectId"] = mergedCookies.bud_projectid;
      if (mergedCookies.bud_userid) extraHeaders["X-Bud-UserId"] = mergedCookies.bud_userid;
      if (mergedCookies.bud_chatsessionid) extraHeaders["X-Bud-ChatSessionId"] = mergedCookies.bud_chatsessionid;
      if (mergedCookies.bud_template) extraHeaders["X-Bud-Template"] = mergedCookies.bud_template;
    }

    db.prepare(
      "UPDATE providers SET cookies = ?, extra_headers = ?, updated_at = ? WHERE id = ?",
    ).run(
      JSON.stringify(mergedCookies),
      Object.keys(extraHeaders).length ? JSON.stringify(extraHeaders) : p.extra_headers,
      Date.now(),
      req.params.providerId,
    );
    res.json({ ok: true });
  });
});

// ─── Static dashboard ─────────────────────────────────────────────────────────

const dashboardDist = join(__dirname, "../../dashboard/dist");
app.use(express.static(dashboardDist));
app.get("*", (_req, res) => {
  res.sendFile(join(dashboardDist, "index.html"), (err) => {
    if (err)
      res
        .status(200)
        .send("AI Gateway is running. Build the dashboard to serve the UI.");
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[Gateway Error]", err.message);
    res
      .status(500)
      .json({ error: { message: err.message, type: "internal_error" } });
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`
  Server  : http://${HOST}:${PORT}
  Dashboard: http://localhost:${PORT}
  OpenAI  : /v1/chat/completions
  Anthropic: /anthropic/v1/messages
  Admin   : /api (x-admin-password)
  `);
});

export default app;
