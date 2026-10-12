'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';

type Result={counts:{prospects:number;processed:number;with_profiles:number;pending:number;failed:number};prospects:Array<{record_id:string;normalized_company_name:string|null;outcome:string|null;notes:string[]|null;profiles:Array<{url:string;platform:string;source:string;relationship:string;duplicates:string[]}>}>};
type BatchResult={mode?:string;campaign:string;selected:number;limit:number;category:string|null;sample:string[];created?:number;replayed?:number};
function defaultCampaign() {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 const date=Object.fromEntries(parts.map(part=>[part.type,part.value]));
 return `social-${date.year}${date.month}${date.day}`;
}

export default function Enrichment() {
 const [offset,setOffset]=useState(0),[data,setData]=useState<Result|null>(null),[error,setError]=useState('');
 const [campaign,setCampaign]=useState(defaultCampaign),[category,setCategory]=useState(''),[limit,setLimit]=useState(4000);
 const [batch,setBatch]=useState<BatchResult|null>(null),[batchError,setBatchError]=useState(''),[batchBusy,setBatchBusy]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  fetch('/api/enrichment?offset='+offset,{signal:controller.signal,cache:'no-store'}).then(async r=>{
   if(!r.ok)throw new Error('Enrichment results are unavailable. Check the database connection and migrations.');
   return r.json();
  }).then(d=>{setData(d);setError('');}).catch(e=>{if(!controller.signal.aborted){setData(null);setError(e.message);}});
  return ()=>controller.abort();
 },[offset,refresh]);
 const move=(n:number)=>{setData(null);setOffset(n);};
 const changeBatchInput=()=>{setBatch(null);setBatchError('');};
 async function runBatch(action:'preview'|'enqueue') {
  setBatchBusy(true);setBatchError('');
  try {
   const response=await fetch('/api/enrichment/batch',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
    body:JSON.stringify({action,mode:'social_profiles',campaign,limit,...(category?{category}:{} )})});
   const body=await response.json();
   if(!response.ok)throw new Error(body.message??body.error??'Batch request failed.');
   if(action==='preview')setBatch(body);
   else {setBatch(body);setRefresh(value=>value+1);}
  } catch(e) {setBatch(null);setBatchError(e instanceof Error?e.message:'Batch request failed.');}
  finally {setBatchBusy(false);}
 }
 return <main className="dashboard"><Link href="/">← Dashboard</Link><header className="page-header"><h1>Enrichment results</h1>
  <p>Public account routes for manual review. Account ownership, availability and direct messaging remain unverified.</p></header>
  <section className="panel enrichment-launch" aria-labelledby="batch-heading">
   <p className="eyebrow">Social account enrichment</p><h2 id="batch-heading">Prepare a prospect batch</h2>
   <p className="muted">Preview the eligible records first. Queueing creates enrichment jobs only; it does not send messages or approve contacts. A configured worker must be running to process the queue.</p>
   <div className="batch-fields">
    <label>Campaign label<input disabled={batchBusy} value={campaign} maxLength={40} autoComplete="off" onChange={event=>{setCampaign(event.target.value);changeBatchInput();}} /></label>
    <label>Category<select disabled={batchBusy} value={category} onChange={event=>{setCategory(event.target.value);changeBatchInput();}}>
     <option value="">All eligible categories</option><option value="B2B">B2B</option><option value="B2C">B2C</option><option value="CRE">Creators (CRE)</option>
    </select></label>
    <label>Maximum records<input disabled={batchBusy} type="number" min={1} max={5000} step={1} value={limit} onChange={event=>{setLimit(Number(event.target.value));changeBatchInput();}} /></label>
   </div>
   <div className="batch-actions"><button type="button" disabled={batchBusy||!campaign||limit<1||limit>5000} onClick={()=>runBatch('preview')}>{batchBusy?'Working…':'Preview eligible records'}</button>
    <button type="button" disabled={batchBusy||!batch||batch.mode==='enqueued'||batch.selected<1} onClick={()=>runBatch('enqueue')}>Queue {batch?.selected??'selected'} records</button></div>
   {batchError&&<p role="alert" className="batch-error">{batchError}</p>}
   {batch&&<div role="status" className="batch-summary"><strong>{batch.mode==='enqueued'?`${batch.created??0} jobs queued`:`${batch.selected} eligible records`}</strong>
    {batch.mode==='enqueued'?<p>{batch.replayed??0} already existed · campaign {batch.campaign}</p>:<p>Campaign {batch.campaign} · maximum {batch.limit}{batch.category?` · category ${batch.category}`:''}</p>}
    {batch.sample?.length>0&&<p>Sample record IDs: {batch.sample.join(', ')}</p>}
    {batch.selected===0&&<p>No eligible records were found. Check category, indexing, identity review and recent enrichment runs.</p>}
   </div>}
  </section>
  {error?<p role="alert">{error}</p>:!data?<p role="status">Loading results…</p>:<>
   <section className="panel"><p>{data.counts.processed} of {data.counts.prospects} records processed · {data.counts.with_profiles} with recorded profiles · {data.counts.pending} jobs pending · {data.counts.failed} failed</p></section>
   {data.prospects.length===0?<p>No records on this page.</p>:data.prospects.map(p=><article className="panel" key={p.record_id}>
    <h2>{p.normalized_company_name??p.record_id}</h2><p>{p.record_id} · {p.outcome?.replaceAll('_',' ')??'Not processed'}</p>
    {p.profiles.length===0?<p>No account routes recorded.</p>:<ul>{p.profiles.map((a,i)=><li key={a.url+a.source+i}>
     <a href={a.url} target="_blank" rel="noreferrer">{a.platform}: {a.url}</a> — {a.relationship.replaceAll('_',' ')} · <a href={a.source} target="_blank" rel="noreferrer">Source</a>
     {a.duplicates.length>0&&<p>Also associated with: {a.duplicates.join(', ')}. Review before use.</p>}
    </li>)}</ul>}{p.notes?.length?<p>{p.notes.join(' · ').replaceAll('_',' ').toLowerCase()}</p>:null}
   </article>)}
   <nav aria-label="Result pages"><button disabled={offset===0} onClick={()=>move(Math.max(0,offset-50))}>Previous</button>{' '}
    <span>Page {offset/50+1}</span>{' '}<button disabled={offset+50>=data.counts.prospects} onClick={()=>move(offset+50)}>Next</button></nav>
  </>}
 </main>;
}
