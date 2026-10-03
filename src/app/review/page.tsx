'use client';
import { useEffect, useState, type FormEvent } from 'react';

type Prospect = {
  record_id: string; normalized_company_name: string | null;
  canonical_domain: string | null; country: string | null;
  email_contacts: number; verification_status: string; suppression_status: string;
};
export default function ContactReviewPage() {
  const [items, setItems] = useState<Prospect[]>([]);
  const [selected, setSelected] = useState('');
  const [email, setEmail] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [checked, setChecked] = useState(false);
  const [message, setMessage] = useState('Loading pending prospects...');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const response = await fetch('/api/outreach/review', { cache: 'no-store' });
    if (!response.ok) { setMessage('Review access or database unavailable.'); return; }
    const data = await response.json();
    const prospects = (data.prospects || []) as Prospect[];
    setItems(prospects);
    setSelected(old => prospects.some(p => p.record_id === old) ? old : (prospects[0]?.record_id || ''));
    setMessage(prospects.length ? 'Select a prospect and inspect the business website.' : 'No pending prospects in this page.');
  }
  useEffect(() => {
    let active = true;
    void fetch('/api/outreach/review', { cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('REVIEW_UNAVAILABLE');
        return response.json();
      })
      .then(data => {
        if (!active) return;
        const prospects = (data.prospects || []) as Prospect[];
        setItems(prospects);
        setSelected(prospects[0]?.record_id || '');
        setMessage(prospects.length ? 'Select a prospect and inspect the business website.' : 'No pending prospects in this page.');
      })
      .catch(() => { if (active) setMessage('Review access or database unavailable.'); });
    return () => { active = false; };
  }, []);
  const prospect = items.find(p => p.record_id === selected);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!checked || !prospect) return;
    setBusy(true);
    setMessage('Recording evidence...');
    try {
      const res = await fetch('/api/outreach/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: selected, email, evidenceUrl,
          exactEmailObserved: true, businessIdentityConfirmed: true,
          businessRelevanceConfirmed: true
        })
      });
      const data = await res.json();
      if (!res.ok) { setMessage('Review not saved: ' + (data.error || res.status)); return; }
      setEmail(''); setEvidenceUrl(''); setChecked(false);
      await refresh();
      setMessage('Evidence recorded. Suppression review queued; this does not send email.');
    } catch { setMessage('Review request failed. Check your connection.'); }
    finally { setBusy(false); }
  }
  return (
    <main style={{ maxWidth: 650, margin: '40px auto', padding: 22, fontFamily: 'Arial,sans-serif', lineHeight: 1.5 }}>
      <h1>VYRO — Contact review</h1>
      <p>Staff-only. Only approve an email you personally found on the matching official company site.
         No outreach is sent from this screen. Record review is not proof of marketing consent.</p>
      <p role="status" aria-live="polite">{message}</p>
      <form onSubmit={submit}>
        <label htmlFor="prospect">Prospect</label><br/>
        <select id="prospect" value={selected} onChange={e=>{setSelected(e.target.value);setChecked(false);setEmail('');setEvidenceUrl('');}}
          required style={{ width: '100%', padding: 12, marginBottom: 16 }}>
          {items.map(p=><option key={p.record_id} value={p.record_id}>{p.normalized_company_name || p.record_id} — {p.country || 'Unknown'}</option>)}
        </select>
        {prospect && <p>Record: {prospect.record_id}<br/>
          Official domain: <strong>{prospect.canonical_domain || 'Missing — cannot review yet'}</strong><br/>
          Existing email entries: {prospect.email_contacts}</p>}
        <label htmlFor="email">Business email visibly published by this company</label><br/>
        <input id="email" type="email" required value={email} onChange={e=>setEmail(e.target.value)}
          autoComplete="off" style={{ width: '100%', boxSizing:'border-box',padding:12,marginBottom:16 }}/>
        <label htmlFor="source">Exact official HTTPS page where you saw that email</label><br/>
        <input id="source" type="url" required value={evidenceUrl} onChange={e=>setEvidenceUrl(e.target.value)}
          placeholder={prospect?.canonical_domain ? 'https://' + prospect.canonical_domain + '/contact' : 'https://...'}
          style={{ width: '100%', boxSizing:'border-box',padding:12,marginBottom:16 }}/>
        <label style={{display:'block',marginBottom:16}}>
          <input type="checkbox" required checked={checked} onChange={e=>setChecked(e.target.checked)}/>
          {' '}I personally confirmed this exact email on that official site, checked the company&apos;s identity, and confirmed relevance to VYRO.
        </label>
        <button type="submit" disabled={busy || !checked || !prospect?.canonical_domain}
          style={{padding:'12px 22px',cursor:'pointer'}}>Record review (no sending)</button>
      </form>
    </main>
  );
}
