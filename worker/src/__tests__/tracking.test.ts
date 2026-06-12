import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import {
  applyTracking,
  injectOpenPixel,
  rewriteClickLinks,
  truncateIp,
} from "../lib/tracking";
import { signTrackingToken, verifyTrackingToken } from "../lib/tracking-token";
import { emailEvents } from "../db/email-events.schema";

const bindings = env as unknown as CloudflareBindings;

describe("tracking-token", () => {
  it("round-trips sentEmailId + recipient", async () => {
    const token = await signTrackingToken(bindings, {
      sentEmailId: "sent-1",
      recipient: "User@Example.com",
    });
    const decoded = await verifyTrackingToken(bindings, token);
    expect(decoded?.sentEmailId).toBe("sent-1");
    expect(decoded?.recipient).toBe("user@example.com");
    expect(decoded?.url).toBeUndefined();
  });

  it("round-trips a url when present (click token)", async () => {
    const token = await signTrackingToken(bindings, {
      sentEmailId: "sent-1",
      recipient: "a@b.com",
      url: "https://example.com/promo?utm_source=email",
    });
    const decoded = await verifyTrackingToken(bindings, token);
    expect(decoded?.url).toBe("https://example.com/promo?utm_source=email");
  });

  it("rejects tampered tokens", async () => {
    const token = await signTrackingToken(bindings, {
      sentEmailId: "sent-1",
      recipient: "a@b.com",
    });
    const [payload, sig] = token.split(".");
    const tampered = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    expect(
      await verifyTrackingToken(bindings, `${payload}.${tampered}`),
    ).toBeNull();
  });
});

describe("injectOpenPixel", () => {
  it("appends a 1x1 tracking pixel before </body>", async () => {
    const html = "<html><body><p>Hi</p></body></html>";
    const out = await injectOpenPixel(bindings, html, {
      sentEmailId: "s1",
      recipient: "u@x.com",
    });
    expect(out).toMatch(
      /<img src="http:\/\/localhost:8080\/t\/o\/[^"]+" width="1" height="1"[^>]*data-saasmail-tracker[^>]*><\/body>/,
    );
  });

  it("appends at end when no </body> tag", async () => {
    const html = "<p>Hi</p>";
    const out = await injectOpenPixel(bindings, html, {
      sentEmailId: "s1",
      recipient: "u@x.com",
    });
    expect(out.startsWith("<p>Hi</p>")).toBe(true);
    expect(out).toMatch(/<img src="[^"]+\/t\/o\/[^"]+"/);
  });
});

describe("rewriteClickLinks", () => {
  it("rewrites http/https hrefs to /t/c/<token>", async () => {
    const html =
      '<p>Click <a href="https://example.com/promo">here</a> and <a href="http://other.io/x">there</a></p>';
    const out = await rewriteClickLinks(bindings, html, {
      sentEmailId: "s1",
      recipient: "u@x.com",
    });
    const matches = out.match(/href="http:\/\/localhost:8080\/t\/c\/[^"]+"/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(2);
    // The original URLs must NOT appear as href values anymore.
    expect(out).not.toMatch(/href="https:\/\/example\.com\/promo"/);
    expect(out).not.toMatch(/href="http:\/\/other\.io\/x"/);
  });

  it("leaves mailto: tel: and fragment links alone", async () => {
    const html =
      '<a href="mailto:x@y.com">mail</a><a href="tel:+34000">tel</a><a href="#top">jump</a>';
    const out = await rewriteClickLinks(bindings, html, {
      sentEmailId: "s1",
      recipient: "u@x.com",
    });
    expect(out).toBe(html);
  });

  it("preserves other attributes on the <a> tag", async () => {
    const html =
      '<a class="cta" href="https://x.com/y" target="_blank" rel="noopener">go</a>';
    const out = await rewriteClickLinks(bindings, html, {
      sentEmailId: "s1",
      recipient: "u@x.com",
    });
    expect(out).toMatch(/class="cta"/);
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/rel="noopener"/);
  });
});

describe("applyTracking", () => {
  it("inserts both pixel and rewritten links", async () => {
    const html = '<html><body><a href="https://x.com/y">y</a></body></html>';
    const out = await applyTracking(bindings, html, {
      sentEmailId: "s1",
      recipient: "u@x.com",
    });
    expect(out).toMatch(/href="http:\/\/localhost:8080\/t\/c\/[^"]+"/);
    expect(out).toMatch(/<img src="http:\/\/localhost:8080\/t\/o\/[^"]+"/);
  });
});

describe("truncateIp", () => {
  it("truncates IPv4 to /24", () => {
    expect(truncateIp("203.0.113.42")).toBe("203.0.113.0");
  });
  it("truncates IPv6 to /48", () => {
    expect(truncateIp("2001:db8:abcd:1234::1")).toBe("2001:db8:abcd::");
  });
  it("handles compressed IPv6", () => {
    expect(truncateIp("2001:db8:abcd::")).toBe("2001:db8:abcd::");
  });
  it("returns null for garbage", () => {
    expect(truncateIp("not-an-ip")).toBeNull();
    expect(truncateIp("")).toBeNull();
    expect(truncateIp(null)).toBeNull();
  });
});

describe("public tracking router", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("GET /t/o/<token> returns a 1x1 GIF and records an opened event", async () => {
    const db = getDb();
    const token = await signTrackingToken(bindings, {
      sentEmailId: "s1",
      recipient: "opener@example.com",
    });
    const res = await workerExports.default.fetch(
      `http://localhost/t/o/${token}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(43);
    // "GIF89a"
    expect(String.fromCharCode(...buf.slice(0, 6))).toBe("GIF89a");

    const rows = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.sentEmailId, "s1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("opened");
    expect(rows[0].recipient).toBe("opener@example.com");
  });

  it("GET /t/o/<bad> still returns the pixel (don't break email)", async () => {
    const db = getDb();
    const res = await workerExports.default.fetch(
      "http://localhost/t/o/garbage.token",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    // ...but no event recorded
    const rows = await db.select().from(emailEvents);
    expect(rows).toHaveLength(0);
  });

  it("GET /t/c/<token> 302-redirects to the original URL and records a click", async () => {
    const db = getDb();
    const token = await signTrackingToken(bindings, {
      sentEmailId: "s2",
      recipient: "clicker@example.com",
      url: "https://example.com/landing?utm=email",
    });
    const res = await workerExports.default.fetch(
      `http://localhost/t/c/${token}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.com/landing?utm=email",
    );
    const rows = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.sentEmailId, "s2"));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("clicked");
    expect(rows[0].url).toBe("https://example.com/landing?utm=email");
  });

  it("GET /t/c/<bad> returns 400, no redirect, no event", async () => {
    const db = getDb();
    const res = await workerExports.default.fetch(
      "http://localhost/t/c/garbage.token",
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    const rows = await db.select().from(emailEvents);
    expect(rows).toHaveLength(0);
  });

  it("multiple opens record multiple events (no dedupe)", async () => {
    const db = getDb();
    const token = await signTrackingToken(bindings, {
      sentEmailId: "s3",
      recipient: "u@x.com",
    });
    await workerExports.default.fetch(`http://localhost/t/o/${token}`);
    await workerExports.default.fetch(`http://localhost/t/o/${token}`);
    const rows = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.sentEmailId, "s3"));
    expect(rows).toHaveLength(2);
  });
});
