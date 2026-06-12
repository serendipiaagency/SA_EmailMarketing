import { Hono } from "hono";
import { html } from "hono/html";
import { verifyUnsubscribeToken } from "../lib/unsubscribe-token";
import { addSuppression } from "../lib/suppression";
import type { Variables } from "../variables";

// Public, unauthenticated unsubscribe endpoint. Two paths:
//   GET  /u/:token  → renders a confirmation page with a POST form
//   POST /u/:token  → idempotent unsubscribe (RFC 8058 one-click target)
//
// Both verify the HMAC token before doing anything. Invalid / tampered
// tokens get a generic 400 — we never leak why.

export const unsubscribeRouter = new Hono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

function renderInvalid(): string {
  return renderPage({
    title: "Enlace inválido",
    body: `<p>Este enlace de baja no es válido o ha sido manipulado.</p>
           <p>Si quieres dejar de recibir nuestros emails, responde a cualquier mensaje pidiéndolo y lo haremos manualmente.</p>`,
  });
}

function renderConfirm(token: string, email: string): string {
  return renderPage({
    title: "Confirma tu baja",
    body: `<p>¿Quieres dejar de recibir emails dirigidos a <strong>${escapeHtml(email)}</strong>?</p>
           <form method="POST" action="/u/${encodeURIComponent(token)}">
             <button type="submit">Sí, dame de baja</button>
           </form>
           <p class="small">No te enviaremos más comunicaciones después de confirmar.</p>`,
  });
}

function renderDone(email: string): string {
  return renderPage({
    title: "Baja completada",
    body: `<p>Listo. <strong>${escapeHtml(email)}</strong> ya no recibirá nuestros emails.</p>
           <p class="small">Si fue un error, contáctanos respondiendo a cualquier mensaje anterior.</p>`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(opts: { title: string; body: string }): string {
  // Plain, deliberately ugly HTML — keeps the unsubscribe flow legible
  // even with assets pipeline broken or CSS blocked.
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#111;}
  h1{font-size:1.4rem;margin-bottom:1rem;}
  button{padding:.75rem 1.5rem;font-size:1rem;cursor:pointer;border:1px solid #111;background:#111;color:#fff;border-radius:6px;}
  button:hover{background:#000;}
  .small{font-size:.85rem;color:#666;margin-top:1.5rem;}
</style>
</head>
<body>
<h1>${escapeHtml(opts.title)}</h1>
${opts.body}
</body>
</html>`;
}

unsubscribeRouter.get("/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyUnsubscribeToken(c.env, token);
  if (!payload) {
    return c.html(renderInvalid(), 400);
  }
  return c.html(renderConfirm(token, payload.email));
});

unsubscribeRouter.post("/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyUnsubscribeToken(c.env, token);
  if (!payload) {
    return c.html(renderInvalid(), 400);
  }
  const db = c.get("db");
  await addSuppression(db, {
    email: payload.email,
    reason: "unsubscribe",
    source: "public-unsubscribe",
    sentEmailId: payload.sentEmailId ?? null,
  });
  return c.html(renderDone(payload.email));
});
