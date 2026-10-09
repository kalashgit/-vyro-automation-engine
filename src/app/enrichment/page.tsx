'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
type Result={counts:{prospects:number;processed:number;with_profiles:number;pending:number;failed:number};prospects:Array<{record_id:string;normalized_company_name:string|null;outcome:string|null;notes:string[]|null;profiles:Array<{url:string;platform:string;source:string;relationship:string;duplicates:string[]}>}>};
export default function Enrichment() {
 const [offset,setOffset]=useState(0),[data,setData]=useState<Result|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  fetch('/api/enrichment?offset='+offset,{signal:controller.signal,cache:'no-store'}).then(async r=>{
   if(!r.ok)throw new Error('Enrichment results are unavailable. Check the database connection and migrations.');
   return r.json();
  }).then(d=>{setData(d);setError('');}).catch(e=>{if(!controller.signal.aborted){setData(null);setError(e.message);}});
  return ()=>controller.abort();
 },[offset]);
 const move=(n:number)=>{setData(null);setOffset(n);};
 return <main className="dashboard"><Link href="/">← Dashboard</Link><header className="page-header"><h1>Enrichment results</h1>
  <p>Public account routes for manual review. Account ownership, availability and direct messaging remain unverified.</p></header>
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
