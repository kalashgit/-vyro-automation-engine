'use client';

import Link from 'next/link';
import { useState } from 'react';

type LedgerReport = { action?: string; total: number; accepted: number; rejected: number; batches?: number;
  certification?: string | null;
  writes?: number; rawRows?: number; prospects?: number; conflicts?: number; deferred?: number; replayed?: number;
  reconciliationJobs?: number; errors?: Array<{ rowNumber: number; recordId: string | null; reason: string }>; sha256?: string };

export default function Ingestion() {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<LedgerReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(action: 'preview' | 'import') {
    if (!file) return;
    setBusy(true); setError('');
    const form = new FormData(); form.set('action', action); form.set('file', file);
    try {
      const response = await fetch('/api/ingestion/ledger', { method: 'POST', body: form, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) {
        if (result.errors) setReport(result);
        throw new Error(result.message ?? result.error ?? 'Ledger request failed.');
      }
      setReport(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ledger request failed.');
    } finally { setBusy(false); }
  }

  function chooseFile(next: File | null) { setFile(next); setReport(null); setError(''); }

  return <main className="dashboard">
    <Link href="/">← Dashboard</Link>
    <header className="page-header"><h1>Import worker ledger</h1>
      <p>Upload a CSV exported from a worker’s Library ledger. The preview validates the whole file; importing writes the audit and prospect rows to PostgreSQL.</p>
    </header>
    <section className="panel enrichment-launch" aria-labelledby="ledger-heading">
      <p className="eyebrow">Prospect intake</p><h2 id="ledger-heading">Review before import</h2>
      <p className="muted">Accepted files are either supervisor-marked VERIFIED NEW ledgers, or one complete 100-row VYRO V5.1 B2B batch with exact VERIFIED NEW status and passed local and global dedupe fields. Worker claims are recorded as claims only; imported prospects still start unchecked and must pass identity, relevance, and suppression checks. Each file is limited to 1,000 rows and 2 MB. Import is transactional and idempotent; duplicate identities are recorded for review. Newly added prospects receive identity-reconciliation jobs. No enrichment or outreach starts from the import.</p>
      <label className="ledger-upload">CSV ledger<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event=>chooseFile(event.target.files?.[0]??null)} /></label>
      <div className="batch-actions"><button type="button" disabled={!file||busy} onClick={()=>submit('preview')}>{busy?'Working…':'Preview ledger'}</button>
        <button type="button" disabled={!file||busy||!report||report.rejected>0||report.action==='imported'} onClick={()=>submit('import')}>Import validated ledger</button></div>
      {file&&<p className="muted">Selected: {file.name} · {(file.size/1024).toFixed(1)} KB</p>}
      {error&&<p role="alert" className="batch-error">{error}</p>}
      {report&&<div role="status" className="batch-summary">
        {report.action==='imported'?<><strong>Import complete · {report.certification==='worker_claim_only'?'worker claims recorded':'supervisor source claims recorded'}</strong><p>{report.rawRows} audited rows · {report.prospects} prospects added · {report.reconciliationJobs} identity checks queued · {report.conflicts} identity conflicts · {report.deferred} deferred · {report.replayed} replayed.</p></>
          :<><strong>{report.accepted} accepted · {report.rejected} rejected · {report.batches} source batches</strong><p>Source status: {report.certification==='worker_v51_claim_only'?'V5.1 worker claim only':report.certification==='supervisor_source_claim'?'supervisor source claim':report.certification==='mixed'?'mixed formats':'not established'}. Preview wrote {report.writes??0} database records. {report.rejected===0?'This file is ready for the explicit import step.':'Fix every rejected row, export the corrected ledger, then preview it again.'}</p></>}
        {report.sha256&&<p>File fingerprint: {report.sha256}</p>}
        {report.errors?.length? <ul>{report.errors.map((issue,i)=><li key={issue.rowNumber+':'+i}>Row {issue.rowNumber} · {issue.recordId||'no record ID'} · {issue.reason.replaceAll('_',' ')}</li>)}</ul>:null}
      </div>}
    </section>
  </main>;
}
