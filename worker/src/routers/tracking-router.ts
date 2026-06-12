import { Hono } from "hono";
import { nanoid } from "nanoid";
import { emailEvents } from "../db/email-events.schema";
import { truncateIp } from "../lib/tracking";
import { verifyTrackingToken } from "../lib/tracking-token";
import type { Variables } from "../variables";

// Public open- and click-tracking endpoints. No auth; tokens are HMAC-
// signed, so a hit on either route is itself the proof of authenticity.
//
// Endpoints:
//   GET /t/o/:token  -> 1x1 transparent GIF, records an "opened" event
//   GET /t/c/:token  -> 302 to the original URL, records a "clicked" event

export const trackingRouter = new Hono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

// 1x1 transparent GIF89a (43 bytes).
const PIXEL_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

function pixelResponse(): Response {
  return new Response(PIXEL_BYTES, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL_BYTES.byteLength),
      // No-cache so every open counts (Gmail's image proxy still caches
      // aggressively, but we ask for what we want).
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
}

function extractClientIp(req: Request): string | null {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

function captureUserAgent(req: Request): string | null {
  const ua = req.headers.get("user-agent");
  if (!ua) return null;
  // Cap to keep storage predictable. UAs >500 chars are almost always
  // junk / oversized for our analytics purposes.
  return ua.length > 500 ? ua.slice(0, 500) : ua;
}

trackingRouter.get("/o/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyTrackingToken(c.env, token);
  // Whatever happens we MUST return the pixel (even on bad token) so we
  // never break the email rendering. Errors are best-effort logged.
  if (payload) {
    try {
      const db = c.get("db");
      await db.insert(emailEvents).values({
        id: nanoid(),
        sentEmailId: payload.sentEmailId,
        recipient: payload.recipient,
        kind: "opened",
        url: null,
        userAgent: captureUserAgent(c.req.raw),
        ipPrefix: truncateIp(extractClientIp(c.req.raw)),
        eventAt: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      console.warn("Failed to record open event:", err);
    }
  }
  return pixelResponse();
});

trackingRouter.get("/c/:token", async (c) => {
  const token = c.req.param("token");
  const payload = await verifyTrackingToken(c.env, token);
  if (!payload || !payload.url) {
    // Without a URL we cannot redirect anywhere useful — return a
    // small text fallback rather than dumping to BASE_URL.
    return c.text("Link expired or invalid", 400);
  }
  try {
    const db = c.get("db");
    await db.insert(emailEvents).values({
      id: nanoid(),
      sentEmailId: payload.sentEmailId,
      recipient: payload.recipient,
      kind: "clicked",
      url: payload.url,
      userAgent: captureUserAgent(c.req.raw),
      ipPrefix: truncateIp(extractClientIp(c.req.raw)),
      eventAt: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.warn("Failed to record click event:", err);
  }
  return c.redirect(payload.url, 302);
});
