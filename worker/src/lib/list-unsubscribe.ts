import { signUnsubscribeToken } from "./unsubscribe-token";

// Build the two RFC-mandated unsubscribe headers for a single recipient.
//
// - `List-Unsubscribe` (RFC 2369): list of <URI> entries. We include the
//   HTTPS endpoint; mailto is optional and not implemented yet.
// - `List-Unsubscribe-Post` (RFC 8058): signals one-click capability so
//   Gmail / Yahoo can issue a single POST without user confirmation.
//
// Gmail's 2024 bulk-sender requirements treat both headers as table
// stakes. Including them on every automated send is the safe default.
export async function buildListUnsubscribeHeaders(
  env: CloudflareBindings,
  recipient: { email: string; sentEmailId?: string },
): Promise<Record<string, string>> {
  const token = await signUnsubscribeToken(env, {
    email: recipient.email,
    sentEmailId: recipient.sentEmailId,
  });
  const base = (env.BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "BASE_URL is not configured. Cannot build List-Unsubscribe URL.",
    );
  }
  const url = `${base}/u/${token}`;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
