import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../database/client.ts';

export type EnrichmentMode = 'official_site' | 'social_profiles';
export type EnrichmentBatchInput = {
  mode: EnrichmentMode;
  campaign: string;
  limit: number;
  category?: string;
  recordId?: string;
  retryDeferred?: boolean;
};
type Queryable = Pool | PoolClient;
type SelectedRecord = { record_id: string };

export class EnrichmentBatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EnrichmentBatchError';
    this.code = code;
  }
}

export function validateEnrichmentBatchInput(input: unknown): EnrichmentBatchInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EnrichmentBatchError('INVALID_BATCH', 'Batch input must be an object.');
  }
  const value = input as Record<string, unknown>;
  const mode = value.mode ?? 'social_profiles';
  if (mode !== 'official_site' && mode !== 'social_profiles') {
    throw new EnrichmentBatchError('INVALID_MODE', 'Choose a supported enrichment mode.');
  }
  const campaign = value.campaign;
  if (typeof campaign !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(campaign)) {
    throw new EnrichmentBatchError('INVALID_CAMPAIGN', 'Campaign must be 1–40 letters, digits, underscores or hyphens.');
  }
  const limit = value.limit ?? 25;
  const maximum = mode === 'social_profiles' ? 5000 : 100;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new EnrichmentBatchError('INVALID_LIMIT', `Limit must be 1–${maximum} for this mode.`);
  }
  const category = value.category;
  if (category !== undefined && category !== null && category !== '' &&
      (typeof category !== 'string' || !/^[A-Z0-9]{1,30}$/.test(category))) {
    throw new EnrichmentBatchError('INVALID_CATEGORY', 'Category must contain 1–30 uppercase letters or digits.');
  }
  const recordId = value.recordId;
  if (recordId !== undefined && recordId !== null &&
      (typeof recordId !== 'string' || !/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(recordId))) {
    throw new EnrichmentBatchError('INVALID_RECORD_ID', 'Record ID is invalid.');
  }
  if (value.retryDeferred !== undefined && typeof value.retryDeferred !== 'boolean') {
    throw new EnrichmentBatchError('INVALID_RETRY_OPTION', 'retryDeferred must be true or false.');
  }
  return {
    mode,
    campaign,
    limit,
    ...(typeof category === 'string' && category ? { category } : {}),
    ...(typeof recordId === 'string' ? { recordId } : {}),
    retryDeferred: value.retryDeferred === true,
  };
}

async function ensureProfileIndexComplete(db: Queryable, mode: EnrichmentMode) {
  if (mode !== 'social_profiles') return;
  const pending = await db.query(`SELECT 1 FROM import_rows r
    WHERE NOT EXISTS(SELECT 1 FROM profile_indexed_rows i WHERE i.import_row_id=r.import_row_id) LIMIT 1`);
  if (pending.rowCount) {
    throw new EnrichmentBatchError('PROFILE_INDEX_INCOMPLETE', 'Index imported account routes before starting social enrichment.');
  }
}

async function selectEligible(db: Queryable, input: EnrichmentBatchInput, lock = false): Promise<SelectedRecord[]> {
  await ensureProfileIndexComplete(db, input.mode);
  const { rows } = await db.query<SelectedRecord>(`SELECT p.record_id FROM prospects p
    WHERE p.identity_status='certified' AND p.relevance_status<>'irrelevant'
      AND ($3::text IS NULL OR p.category=$3) AND p.suppression_status<>'suppressed' AND ($1::text IS NULL OR p.record_id=$1)
      AND NOT EXISTS (SELECT 1 FROM identity_conflicts c WHERE c.existing_record_id=p.record_id AND c.review_status='pending')
      AND ($1::text IS NOT NULL OR (
        ($4='social_profiles' OR (p.canonical_domain IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM contact_points c WHERE c.record_id=p.record_id AND c.channel='email')
        AND NOT EXISTS(SELECT 1 FROM import_rows r WHERE r.batch_id=p.source_batch_id AND r.raw_record_id=p.record_id
          AND COALESCE(r.raw_payload->>'Email','') ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,24}')
        ))
        AND ($4<>'official_site' OR NOT EXISTS(SELECT 1 FROM enrichment_runs r WHERE r.record_id=p.record_id AND r.completed_at>clock_timestamp()-interval '7 days'))
        AND ($4<>'social_profiles' OR NOT EXISTS(SELECT 1 FROM (SELECT completed_at,notes FROM social_enrichment_runs WHERE record_id=p.record_id ORDER BY completed_at DESC,run_id DESC LIMIT 1) r WHERE r.completed_at>clock_timestamp()-interval '7 days' AND NOT ($5::boolean AND r.notes && ARRAY['SEARCH_DAILY_LIMIT','SEARCH_NOT_CONFIGURED','SEARCH_ALREADY_IN_PROGRESS']::text[])))
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.type='enrich_contact' AND j.payload->>'recordId'=p.record_id AND j.payload->>'mode'=$4 AND j.status IN ('queued','leased','retry'))
      ))
    ORDER BY CASE WHEN p.category='B2B' THEN 0 ELSE 1 END,
      CASE WHEN EXISTS (SELECT 1 FROM import_rows r WHERE r.batch_id=p.source_batch_id AND r.raw_record_id=p.record_id
        AND nullif(btrim(r.raw_payload->>'Phone'),'') IS NOT NULL) THEN 0 ELSE 1 END,
      p.created_at,p.record_id LIMIT $2 ${lock ? 'FOR UPDATE OF p SKIP LOCKED' : ''}`,
  [input.recordId ?? null, input.limit, input.category ?? null, input.mode, input.retryDeferred ?? false]);
  return rows;
}

export async function previewEnrichmentBatch(pool: Pool, rawInput: unknown) {
  const input = validateEnrichmentBatchInput(rawInput);
  const records = await selectEligible(pool, input);
  return { mode: input.mode, campaign: input.campaign, selected: records.length, limit: input.limit,
    category: input.category ?? null, sample: records.slice(0, 10).map(row => row.record_id) };
}

export async function queueEnrichmentBatch(pool: Pool, rawInput: unknown) {
  const input = validateEnrichmentBatchInput(rawInput);
  return withTransaction(pool, async client => {
    const records = await selectEligible(client, input, true);
    if (!records.length) return { mode: 'enqueued' as const, enrichmentMode: input.mode, campaign: input.campaign,
      selected: 0, created: 0, replayed: 0 };
    const modePrefix = input.mode === 'official_site' ? 'enrichment' : 'social-enrichment';
    const jobs = records.map(row => ({
      record_id: row.record_id,
      idempotency_key: `${modePrefix}:v1:${input.campaign}:${createHash('sha256').update(row.record_id).digest('hex')}`,
    }));
    const keys = jobs.map(job => job.idempotency_key);
    const { rows: created } = await client.query<{ idempotency_key: string }>(`WITH items AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(record_id text,idempotency_key text)
    ) INSERT INTO jobs(type,payload,idempotency_key,retry_backoff_ms,retry_max_backoff_ms,max_attempts)
      SELECT 'enrich_contact',jsonb_build_object('recordId',record_id,'mode',$2::text),idempotency_key,30000,300000,4 FROM items
      ON CONFLICT(idempotency_key) DO NOTHING RETURNING idempotency_key`, [JSON.stringify(jobs), input.mode]);
    const { rows: existing } = await client.query<{ idempotency_key: string; type: string; payload: { recordId?: string; mode?: string };
      max_attempts: number; retry_backoff_ms: number; retry_max_backoff_ms: number }>(`SELECT idempotency_key,type,payload,max_attempts,retry_backoff_ms,retry_max_backoff_ms
      FROM jobs WHERE idempotency_key=ANY($1::text[])`, [keys]);
    const expected = new Map(jobs.map(job => [job.idempotency_key, job.record_id]));
    if (existing.length !== jobs.length || existing.some(job => job.type !== 'enrich_contact' ||
      job.payload.recordId !== expected.get(job.idempotency_key) || job.payload.mode !== input.mode ||
      job.max_attempts !== 4 || job.retry_backoff_ms !== 30000 || job.retry_max_backoff_ms !== 300000)) {
      throw new EnrichmentBatchError('IDEMPOTENCY_CONFLICT', 'A batch key already exists with different job settings.');
    }
    return { mode: 'enqueued' as const, enrichmentMode: input.mode, campaign: input.campaign,
      selected: records.length, created: created.length, replayed: records.length - created.length };
  });
}
