import { Hono } from "hono";
import { addSuppression, type SuppressionReason } from "../lib/suppression";
import { readSvixHeaders, verifySvixSignature } from "../lib/svix-signature";
import type { Variables } from "../variables";

// Public webhook surface. No user auth: each route MUST verify the
// provider's request signature before doing anything with the payload.

export const webhooksRouter = new Hono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

interface ResendEventPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

// Map a Resend event type to our internal suppression reason.
// Returns null when the event is informational (no suppression action).
function reasonFromResendEvent(eventType: string): SuppressionReason | null {
  switch (eventType) {
    case "email.bounced":
      return "hard_bounce";
    case "email.complained":
      return "complaint";
    default:
      // delivered / opened / clicked / sent / delivery_delayed — no
      // suppression action (yet). Tracked elsewhere if we add open/click
      // analytics later.
      return null;
  }
}

function recipientsFromEvent(payload: ResendEventPayload): string[] {
  const to = payload.data?.to;
  if (!to) return [];
  if (typeof to === "string") return [to];
  if (Array.isArray(to))
    return to.filter((s): s is string => typeof s === "string");
  return [];
}

webhooksRouter.post("/resend", async (c) => {
  const secret = (c.env as unknown as { RESEND_WEBHOOK_SECRET?: string })
    .RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfigured: refuse rather than silently accept unsigned events.
    return c.json(
      {
        error: "webhook_not_configured",
        message:
          "Set RESEND_WEBHOOK_SECRET with `wrangler secret put RESEND_WEBHOOK_SECRET` (whsec_… value from Resend dashboard).",
      },
      503,
    );
  }

  const rawBody = await c.req.text();
  const svixHeaders = readSvixHeaders(c.req.raw.headers);
  const verify = await verifySvixSignature(secret, rawBody, svixHeaders);
  if (!verify.ok) {
    // Never leak the reason in the body — Svix probes for verbose errors.
    console.warn(`Resend webhook signature rejected: ${verify.reason}`);
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: ResendEventPayload;
  try {
    payload = JSON.parse(rawBody) as ResendEventPayload;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const eventType = payload.type ?? "";
  const reason = reasonFromResendEvent(eventType);
  if (!reason) {
    // Acknowledge informational events so Resend doesn't retry forever.
    return c.json({ ok: true, action: "ignored", event: eventType });
  }

  const recipients = recipientsFromEvent(payload);
  if (recipients.length === 0) {
    console.warn(`Resend webhook ${eventType} with no recipients`);
    return c.json({ ok: true, action: "no_recipient" });
  }

  const db = c.get("db");
  const sentEmailId = payload.data?.email_id ?? null;
  for (const recipient of recipients) {
    await addSuppression(db, {
      email: recipient,
      reason,
      source: "webhook:resend",
      sentEmailId,
      metadata: payload,
    });
  }

  return c.json({
    ok: true,
    action: "suppressed",
    reason,
    recipients: recipients.length,
  });
});
