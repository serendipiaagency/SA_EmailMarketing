import { describe, it, expect } from "vitest";
import { detectBounce } from "../lib/detect-bounce";
import type { ParsedEmail } from "../lib/email-parser";

function makeParsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: { address: "sender@example.com", name: "Sender" },
    to: "inbox@saasmail.test",
    cc: [],
    subject: "",
    bodyHtml: null,
    bodyText: null,
    messageId: null,
    headers: {},
    attachments: [],
    auth: { spf: null, dkim: null, dmarc: null },
    ...overrides,
  };
}

describe("detectBounce", () => {
  it("returns null for a normal user-to-user email", () => {
    const parsed = makeParsed({
      from: { address: "alice@example.com", name: "Alice" },
      subject: "Hello",
      bodyText: "How are you?",
    });
    expect(detectBounce(parsed)).toBeNull();
  });

  it("detects a Postfix-style DSN by From: MAILER-DAEMON", () => {
    const parsed = makeParsed({
      from: {
        address: "MAILER-DAEMON@mail.example.com",
        name: "Mail Delivery System",
      },
      subject: "Undelivered Mail Returned to Sender",
      headers: {
        "content-type":
          'multipart/report; report-type=delivery-status; boundary="X"',
      },
      bodyText: [
        "This is the mail system at host mail.example.com.",
        "",
        "Final-Recipient: rfc822; bounced@example.com",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 <bounced@example.com>: User unknown",
      ].join("\n"),
    });
    const result = detectBounce(parsed);
    expect(result).not.toBeNull();
    expect(result?.recipient).toBe("bounced@example.com");
    expect(result?.isHard).toBe(true);
    expect(result?.reason).toBe("hard_bounce");
    expect(result?.status).toBe("5.1.1");
  });

  it("detects a Cloudflare-style DSN by Content-Type alone", () => {
    const parsed = makeParsed({
      from: { address: "noreply@cloudflare.com", name: "" },
      subject: "Delivery Status Notification (Failure)",
      headers: {
        "content-type": "multipart/report; report-type=delivery-status",
      },
      bodyText: [
        "Final-Recipient: rfc822; gone@example.com",
        "Status: 5.7.1",
      ].join("\n"),
    });
    const result = detectBounce(parsed);
    expect(result?.recipient).toBe("gone@example.com");
    expect(result?.isHard).toBe(true);
  });

  it("uses X-Failed-Recipients header when present", () => {
    const parsed = makeParsed({
      from: { address: "postmaster@example.com", name: "" },
      subject: "Returned mail",
      headers: {
        "x-failed-recipients": "first@example.com, second@example.com",
      },
      bodyText: "Status: 5.1.1",
    });
    const result = detectBounce(parsed);
    expect(result?.recipient).toBe("first@example.com");
  });

  it("classifies 4.x.x as soft bounce", () => {
    const parsed = makeParsed({
      from: { address: "mailer-daemon@example.com", name: "" },
      subject: "Delivery deferred",
      bodyText: [
        "Final-Recipient: rfc822; deferred@example.com",
        "Status: 4.2.1",
      ].join("\n"),
    });
    const result = detectBounce(parsed);
    expect(result?.isHard).toBe(false);
    expect(result?.reason).toBe("soft_bounce_repeated");
  });

  it("returns recipient null when extraction fails but bounce shape matches", () => {
    const parsed = makeParsed({
      from: {
        address: "mailer-daemon@example.com",
        name: "Mail Delivery System",
      },
      subject: "Undelivered Mail Returned to Sender",
      bodyText: "Some opaque body with no Final-Recipient line.",
    });
    const result = detectBounce(parsed);
    expect(result).not.toBeNull();
    expect(result?.recipient).toBeNull();
  });

  it("matches via subject keyword as last resort", () => {
    const parsed = makeParsed({
      from: { address: "weird@example.com", name: "" },
      subject: "Mail Delivery Failed: returning message to sender",
      bodyText: [
        "Final-Recipient: rfc822; dead@example.com",
        "Status: 5.5.0",
      ].join("\n"),
    });
    const result = detectBounce(parsed);
    expect(result?.recipient).toBe("dead@example.com");
  });

  it("matches via Auto-Submitted header heuristic", () => {
    const parsed = makeParsed({
      from: { address: "anything@example.com", name: "" },
      subject: "Out of office",
      headers: { "auto-submitted": "auto-replied" },
      bodyText: "I am away",
    });
    const result = detectBounce(parsed);
    // out-of-office responders also flip auto-submitted — but we don't
    // get a recipient out of them, so they end up as bounce-shape with
    // recipient null. Test asserts the shape detector still fires.
    expect(result).not.toBeNull();
    expect(result?.recipient).toBeNull();
  });
});
