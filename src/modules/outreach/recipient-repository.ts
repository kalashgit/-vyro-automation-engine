import type { Pool } from "pg";
import { evaluateRecipient, normalizeEmail } from "./recipient-gate.ts";

/**
 * DB-backed fail-closed eligibility for one recipient. An independently reviewed
 * evidence row is required; staging a contact point cannot create one.
 * This is a read-only preflight, NOT an authorization to send: repeat inside
 * the send reservation transaction after the approved provider is implemented.
 */
export async function inspectRecipient(pool: Pool, recordId: string, email: string,
  now: Date = new Date()) {
  const normalized = normalizeEmail(email);
  if (!normalized || !/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(recordId)) {
    return { eligible: false, reasons: ["INVALID_RECIPIENT"], normalizedEmail: normalized };
  }
  const query = await pool.query(`
    SELECT p.record_id, p.identity_status, p.verification_status,
      p.relevance_status, p.contactability_status, p.suppression_status,
      p.suppression_checked_at,
      e.source_url, e.approved_at AS verified_at,
      EXISTS (
        SELECT 1 FROM email_suppressions s WHERE s.email_normalized=$2
      ) AS suppressed_email
    FROM prospects p
    LEFT JOIN LATERAL (
      SELECT evidence.source_url,evidence.approved_at
      FROM recipient_verification_evidence evidence
      WHERE evidence.record_id=p.record_id AND evidence.email_normalized=$2
        AND evidence.revoked_at IS NULL
        AND evidence.evidence_checked_at >= $3::timestamptz - INTERVAL '30 days'
        AND evidence.approved_at <= $3::timestamptz
      ORDER BY evidence.approved_at DESC LIMIT 1
    ) e ON TRUE
    WHERE p.record_id=$1 AND EXISTS (
      SELECT 1 FROM contact_points c
      WHERE c.record_id=p.record_id AND c.channel='email'
        AND lower(btrim(c.value))=$2
    )`, [recordId, normalized, now]);
  if (query.rowCount !== 1) {
    return { eligible: false, reasons: ["RECIPIENT_NOT_FOUND_OR_NO_CONTACT"], normalizedEmail: normalized };
  }
  const p = query.rows[0];
  return evaluateRecipient({
    recordId, email: normalized, sourceUrl: p.source_url ?? null,
    identityStatus: p.identity_status,
    prospectVerificationStatus: p.verification_status,
    relevanceStatus: p.relevance_status,
    contactabilityStatus: p.contactability_status,
    emailVerificationStatus: p.verified_at ? "verified" : "unverified",
    emailVerifiedAt: p.verified_at ?? null,
    suppressionStatus: p.suppression_status,
    suppressionCheckedAt: p.suppression_checked_at,
    suppressedEmail: p.suppressed_email,
    blocked: false
  },now);
}
