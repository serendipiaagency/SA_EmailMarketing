import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createEmailSender, type EmailSender } from "./email-sender";
import { isDemoMode } from "./is-dev";
import { schema } from "../db/schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { interpolate } from "./interpolate";
import { formatFromAddress } from "./format-from-address";
import { generateMessageId } from "./message-id";
import { isSuppressed } from "./suppression";
import { buildListUnsubscribeHeaders } from "./list-unsubscribe";
import { applyTracking } from "./tracking";

// Safety cap: how many due emails a single cron run will process inline.
// Without Cloudflare Queues we process synchronously inside the scheduled
// handler; this bounds wall-clock + CPU per run. Anything above the cap
// is picked up on the next cron tick. Raise the cron frequency in
// wrangler.jsonc if you need higher throughput.
const MAX_EMAILS_PER_RUN = 100;

/**
 * Cron handler: find due pending emails and send them inline.
 *
 * This deployment runs without Cloudflare Queues (Workers Free plan), so
 * the cron both discovers and dispatches. Each row is "claimed" by
 * flipping it to "queued" before processing so overlapping cron runs
 * don't double-send; on an unexpected throw it's reset to "pending" so
 * the next run retries (this replaces the queue's automatic retry).
 */
export async function handleScheduled(env: CloudflareBindings): Promise<void> {
  if (isDemoMode(env)) {
    console.log("[demo] Skipping scheduled sequence dispatch");
    return;
  }
  const db = drizzle(env.DB, { schema });
  const sender = createEmailSender(env);
  const now = Math.floor(Date.now() / 1000);

  const dueEmails = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.status, "pending"),
        lte(sequenceEmails.scheduledAt, now),
      ),
    )
    .limit(MAX_EMAILS_PER_RUN);

  if (dueEmails.length === 0) return;

  let processed = 0;
  for (const email of dueEmails) {
    // Claim the row before sending so an overlapping cron run skips it
    // (processSequenceEmail bails on anything that isn't "queued").
    await db
      .update(sequenceEmails)
      .set({ status: "queued" })
      .where(eq(sequenceEmails.id, email.id));

    try {
      await processSequenceEmail(db, sender, env, email.id);
      processed++;
    } catch (err) {
      console.error(`Failed to process sequence email ${email.id}:`, err);
      // Reset to pending so the next cron run retries. Guard on the
      // claimed status so we don't clobber a terminal state the
      // processor may have already written.
      await db
        .update(sequenceEmails)
        .set({ status: "pending" })
        .where(
          and(
            eq(sequenceEmails.id, email.id),
            eq(sequenceEmails.status, "queued"),
          ),
        );
    }
  }

  console.log(`Processed ${processed}/${dueEmails.length} sequence emails`);
}

export async function processSequenceEmail(
  db: ReturnType<typeof drizzle>,
  sender: EmailSender,
  env: CloudflareBindings,
  sequenceEmailId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Fetch the outbox row
  const emailRows = await db
    .select()
    .from(sequenceEmails)
    .where(eq(sequenceEmails.id, sequenceEmailId))
    .limit(1);

  if (emailRows.length === 0) return;
  const seqEmail = emailRows[0];

  // Bail if not queued (already cancelled or sent)
  if (seqEmail.status !== "queued") return;

  // Fetch enrollment — bail if not active
  const enrollmentRows = await db
    .select()
    .from(sequenceEnrollments)
    .where(eq(sequenceEnrollments.id, seqEmail.enrollmentId))
    .limit(1);

  if (enrollmentRows.length === 0) return;
  const enrollment = enrollmentRows[0];

  const fromAddress = enrollment.fromAddress;

  if (enrollment.status !== "active") {
    // Enrollment was cancelled while queued — mark email as cancelled
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  // Fetch the template
  const templateRows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, seqEmail.templateSlug))
    .limit(1);

  if (templateRows.length === 0) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  const template = templateRows[0];

  // Fetch person for auto-variables
  const personRows = await db
    .select()
    .from(people)
    .where(eq(people.id, enrollment.personId))
    .limit(1);

  if (personRows.length === 0) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  const person = personRows[0];

  // Suppression gate: a person added to the suppression list (bounce,
  // complaint, unsubscribe) after enrollment must not receive any more
  // sequence emails. Cancel this email + remaining ones in the enrollment.
  if (await isSuppressed(db, person.email)) {
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    await db
      .update(sequenceEnrollments)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(sequenceEnrollments.id, enrollment.id));
    // Cancel any remaining pending/queued emails in this enrollment so
    // they don't fire after the gate.
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(sequenceEmails.enrollmentId, enrollment.id),
          eq(sequenceEmails.status, "pending"),
        ),
      );
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(sequenceEmails.enrollmentId, enrollment.id),
          eq(sequenceEmails.status, "queued"),
        ),
      );
    return;
  }

  // Merge variables: person auto-vars + enrollment custom vars (custom wins)
  const customVars: Record<string, string> = JSON.parse(enrollment.variables);
  const mergedVars: Record<string, string> = {
    name: person.name ?? "",
    email: person.email,
    ...customVars,
  };

  // Interpolate template
  const renderedSubject = interpolate(template.subject, mergedVars);
  const renderedHtml = interpolate(template.bodyHtml, mergedVars);

  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  // Pre-generate sentId so the unsubscribe + tracking tokens can
  // reference this message.
  const sentId = nanoid();
  const listUnsubHeaders = await buildListUnsubscribeHeaders(env, {
    email: person.email,
    sentEmailId: sentId,
  });
  const trackedHtml = await applyTracking(env, renderedHtml, {
    sentEmailId: sentId,
    recipient: person.email,
  });
  const result = await sender.send({
    from: formattedFrom,
    to: person.email,
    subject: renderedSubject,
    html: trackedHtml,
    headers: { "Message-ID": messageId, ...listUnsubHeaders },
  });

  // Store sent email record
  await db.insert(sentEmails).values({
    id: sentId,
    personId: person.id,
    fromAddress,
    toAddress: person.email,
    subject: renderedSubject,
    bodyHtml: renderedHtml,
    bodyText: null,
    messageId,
    resendId: result.id,
    status: result.error ? "failed" : "sent",
    sentAt: now,
    createdAt: now,
  });

  // Update outbox row
  if (result.error) {
    await db
      .update(sequenceEmails)
      .set({ status: "failed" })
      .where(eq(sequenceEmails.id, sequenceEmailId));
    return;
  }

  await db
    .update(sequenceEmails)
    .set({ status: "sent", sentAt: now, sentEmailId: sentId })
    .where(eq(sequenceEmails.id, sequenceEmailId));

  // Check if this was the last step — if so, mark enrollment completed
  const remainingPending = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollment.id),
        eq(sequenceEmails.status, "pending"),
      ),
    )
    .limit(1);

  const remainingQueued = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollment.id),
        eq(sequenceEmails.status, "queued"),
      ),
    )
    .limit(1);

  if (remainingPending.length === 0 && remainingQueued.length === 0) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed" })
      .where(eq(sequenceEnrollments.id, enrollment.id));
  }
}
