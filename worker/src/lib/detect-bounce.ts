import type { ParsedEmail } from "./email-parser";
import type { SuppressionReason } from "./suppression";

export interface DetectedBounce {
  /** Address that bounced, lowercased, or null if not extractable. */
  recipient: string | null;
  /** True for permanent failures (SMTP 5.x.x), false for transient (4.x.x). */
  isHard: boolean;
  /** Suppression reason to record. */
  reason: SuppressionReason;
  /** SMTP enhanced status code, if present (e.g. "5.1.1"). */
  status: string | null;
  /** From, subject, status — kept for the suppression metadata column. */
  metadata: Record<string, string | null>;
}

const BOUNCE_FROM_RE = /^(?:mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT_RE =
  /(undelivered|undeliverable|delivery (?:status|failure|notification)|failure notice|returned mail|mail delivery|message not delivered)/i;
const FINAL_RECIPIENT_RE =
  /^final-recipient:\s*(?:rfc822|x-postfix)\s*;\s*([^\s<>]+)/im;
const FAILED_RECIPIENTS_HEADER_RE = /^x-failed-recipients:\s*([^\r\n]+)$/im;
const STATUS_RE = /^status:\s*(\d\.\d{1,3}\.\d{1,3})/im;

function getHeader(
  headers: Record<string, string>,
  key: string,
): string | undefined {
  // postal-mime sometimes lowercases keys, sometimes not. Try both.
  return (
    headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()]
  );
}

function isReportContentType(headers: Record<string, string>): boolean {
  const ct = getHeader(headers, "content-type") ?? "";
  return (
    /multipart\/report/i.test(ct) && /report-type=delivery-status/i.test(ct)
  );
}

function isBounceShape(parsed: ParsedEmail): boolean {
  if (BOUNCE_FROM_RE.test(parsed.from.address)) return true;
  if (isReportContentType(parsed.headers)) return true;
  if (BOUNCE_SUBJECT_RE.test(parsed.subject)) return true;
  // RFC 3834 auto-submitted marker as a last-resort heuristic.
  const autoSub = getHeader(parsed.headers, "auto-submitted") ?? "";
  if (/auto-replied|auto-generated/i.test(autoSub)) return true;
  return false;
}

function extractRecipient(parsed: ParsedEmail): string | null {
  const failedHeader = getHeader(parsed.headers, "x-failed-recipients") ?? "";
  if (failedHeader) {
    // header may contain comma-separated list — take the first.
    const first = failedHeader.split(",")[0]?.trim();
    if (first && first.includes("@")) return first.toLowerCase();
  }

  // Look for Final-Recipient inside the report body (typically lives in
  // the message/delivery-status part, but postal-mime flattens text).
  const body = parsed.bodyText ?? "";
  const finalMatch = body.match(FINAL_RECIPIENT_RE);
  if (finalMatch?.[1]) {
    return finalMatch[1].trim().toLowerCase();
  }

  // Same regex against any X-Failed-Recipients line that postal-mime
  // surfaced into the body instead of headers.
  const bodyHeaderMatch = body.match(FAILED_RECIPIENTS_HEADER_RE);
  if (bodyHeaderMatch?.[1]) {
    const first = bodyHeaderMatch[1].split(",")[0]?.trim();
    if (first && first.includes("@")) return first.toLowerCase();
  }

  return null;
}

function extractStatus(parsed: ParsedEmail): string | null {
  const body = parsed.bodyText ?? "";
  const m = body.match(STATUS_RE);
  return m?.[1] ?? null;
}

export function detectBounce(parsed: ParsedEmail): DetectedBounce | null {
  if (!isBounceShape(parsed)) return null;

  const recipient = extractRecipient(parsed);
  const status = extractStatus(parsed);
  const isHard = status ? status.startsWith("5.") : true; // conservative
  return {
    recipient,
    isHard,
    reason: isHard ? "hard_bounce" : "soft_bounce_repeated",
    status,
    metadata: {
      from: parsed.from.address,
      subject: parsed.subject,
      status,
      messageId: parsed.messageId,
    },
  };
}
