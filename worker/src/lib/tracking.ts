import { signTrackingToken } from "./tracking-token";

// Inject open + click trackers into outbound HTML. Both are opt-in via
// `BASE_URL` being configured and the unsubscribe secret being present
// (the same secret signs tracking tokens — see tracking-token.ts).

const LINK_HREF_RE = /(<a\s[^>]*?\bhref\s*=\s*["'])([^"']+)(["'])/gi;
const TRACKABLE_URL_RE = /^https?:\/\//i;
const TRACKING_PIXEL_MARKER = "data-saasmail-tracker";

function getBaseUrl(env: CloudflareBindings): string {
  const base = (env.BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error("BASE_URL is not configured.");
  }
  return base;
}

export interface RewriteContext {
  sentEmailId: string;
  recipient: string;
}

// Append an invisible 1x1 PNG beacon at the end of the body so most
// email clients fetch it on open (some block remote images by default —
// no perfect solution to that).
//
// The pixel carries a `data-saasmail-tracker` attribute so we can spot
// (and remove) our own beacons when a user forwards an email back to us.
export async function injectOpenPixel(
  env: CloudflareBindings,
  html: string,
  ctx: RewriteContext,
): Promise<string> {
  const token = await signTrackingToken(env, {
    sentEmailId: ctx.sentEmailId,
    recipient: ctx.recipient,
  });
  const url = `${getBaseUrl(env)}/t/o/${token}`;
  const pixel = `<img src="${url}" width="1" height="1" alt="" style="display:none;border:0;outline:none" ${TRACKING_PIXEL_MARKER}="1">`;

  // Prefer right before </body> if present; otherwise append at the end.
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + pixel + html.slice(bodyClose);
  }
  return html + pixel;
}

// Rewrite every `<a href="https?://…">` to point at our click-tracking
// endpoint. Skips fragment links (`#section`), mailto:, tel:, and any
// scheme we don't explicitly recognize.
export async function rewriteClickLinks(
  env: CloudflareBindings,
  html: string,
  ctx: RewriteContext,
): Promise<string> {
  // First pass: collect all matches with their indices. Async token
  // generation can't be done inside `String.replace`, so we materialize
  // the work then splice the rewrites in reverse order to keep indices
  // stable.
  const matches: Array<{
    start: number;
    end: number;
    pre: string;
    url: string;
    post: string;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_HREF_RE.exec(html)) !== null) {
    if (!TRACKABLE_URL_RE.test(m[2])) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      pre: m[1],
      url: m[2],
      post: m[3],
    });
  }
  if (matches.length === 0) return html;

  const tokens = await Promise.all(
    matches.map((match) =>
      signTrackingToken(env, {
        sentEmailId: ctx.sentEmailId,
        recipient: ctx.recipient,
        url: match.url,
      }),
    ),
  );

  const base = getBaseUrl(env);
  let out = "";
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    out += html.slice(cursor, match.start);
    out += `${match.pre}${base}/t/c/${tokens[i]}${match.post}`;
    cursor = match.end;
  }
  out += html.slice(cursor);
  return out;
}

// Single entrypoint used from send paths.
export async function applyTracking(
  env: CloudflareBindings,
  html: string,
  ctx: RewriteContext,
): Promise<string> {
  const withLinks = await rewriteClickLinks(env, html, ctx);
  return injectOpenPixel(env, withLinks, ctx);
}

// Truncate IP to /24 (v4) or /48 (v6). Returns null on unparsable
// input. Storing the truncated form preserves geo/abuse signal without
// pinning a row to an identifiable device, which matters under
// GDPR/LOPDGDD because the full IP is PII.
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;

  // IPv4
  const v4 = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  }

  // IPv6 — keep first three hextets, zero the rest.
  if (trimmed.includes(":")) {
    // Normalize: take the part before any zone id (%eth0), expand `::`
    // by inserting empty parts, then truncate.
    const noZone = trimmed.split("%")[0];
    if (noZone.includes("::")) {
      const [head, tail] = noZone.split("::");
      const headParts = head ? head.split(":") : [];
      if (headParts.length >= 3) {
        return `${headParts.slice(0, 3).join(":")}::`;
      }
      // Fall through to bracket form
    }
    const parts = noZone.split(":");
    if (parts.length >= 3) {
      return `${parts.slice(0, 3).join(":")}::`;
    }
  }

  return null;
}
