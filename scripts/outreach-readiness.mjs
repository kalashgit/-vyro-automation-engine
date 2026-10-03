// Read-only readiness report. Never sends email or modifies prospects.
import { getDatabasePool } from '../src/modules/database/client.ts';
const pool = getDatabasePool();
try {
  const { rows: [result] } = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE identity_status='certified')::int AS identity_certified,
      count(*) FILTER (WHERE verification_status='verified')::int AS evidence_verified,
      count(*) FILTER (WHERE suppression_status='passed')::int AS suppression_passed,
      count(*) FILTER (WHERE relevance_status='relevant')::int AS relevant,
      count(*) FILTER (WHERE contactability_status='contactable')::int AS contactable,
      count(*) FILTER (
        WHERE identity_status='certified' AND verification_status='verified'
          AND suppression_status='passed' AND relevance_status='relevant'
          AND contactability_status='contactable'
          AND EXISTS (
            SELECT 1 FROM contact_points c
            WHERE c.record_id = prospects.record_id AND c.channel='email'
              AND c.verification_status='verified' AND c.source_url ~ '^https?://'
              AND NOT EXISTS (
                SELECT 1 FROM email_suppressions s
                WHERE s.email_normalized=lower(btrim(c.value))
              )
          )
      )::int AS prospect_eligible_with_verified_unsuppressed_email
    FROM prospects`);
  console.log('VYRO_OUTREACH_READINESS ' + JSON.stringify(result));
  console.log('VYRO_OUTREACH_MODE READ_ONLY_NO_SEND');
} finally {
  await pool.end();
}
