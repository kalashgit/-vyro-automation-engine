import { getDatabasePool } from '../src/modules/database/client.ts';
import { previewEnrichmentBatch, queueEnrichmentBatch, validateEnrichmentBatchInput } from '../src/modules/enrichment/batch.ts';

// Preview is the default. Apply creates only durable enrichment jobs; it never sends messages.
const args = process.argv.slice(2);
const allowed = new Set(['--apply', '--limit', '--campaign', '--record-id', '--mode', '--category', '--retry-deferred']);
let retryDeferred = false, apply = false, limit = 25, campaign, recordId, mode = 'official_site', category;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (!allowed.has(flag)) throw new Error('Unknown argument: ' + flag);
  if (flag === '--retry-deferred') { retryDeferred = true; continue; }
  if (flag === '--apply') { apply = true; continue; }
  const value = args[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
  if (flag === '--limit') limit = Number(value);
  if (flag === '--campaign') campaign = value;
  if (flag === '--record-id') recordId = value;
  if (flag === '--mode') mode = value;
  if (flag === '--category') category = value;
}
const input = validateEnrichmentBatchInput({ mode, campaign, limit, category, recordId, retryDeferred });
const pool = getDatabasePool();
try {
  const result = apply ? await queueEnrichmentBatch(pool, input) : await previewEnrichmentBatch(pool, input);
  console.log(JSON.stringify({ mode: apply ? 'enqueued' : 'preview', enrichmentMode: input.mode,
    selected: result.selected, created: 'created' in result ? result.created : 0,
    replayed: 'replayed' in result ? result.replayed : 0, campaign: input.campaign }));
} finally {
  await pool.end();
}
