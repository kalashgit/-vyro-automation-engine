import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {LeasedJob} from '../queue/types.ts';
import {withTransaction} from '../database/client.ts';
import {JobExecutionError} from '../workers/worker.ts';
import {normalizeProfile} from './public-profiles.mjs';
export type SearchResult={url:string;title:string};
export type ProfileSearch=(query:string,signal:AbortSignal)=>Promise<SearchResult[]>;
const domains=['instagram.com','facebook.com','youtube.com','tiktok.com','twitch.tv','x.com','twitter.com','reddit.com','linkedin.com','steamcommunity.com','linktr.ee'];
export function publicAlias(raw:Record<string,unknown>):string|null {
 for(const key of ['Username','Handle','Entity','Name']) {
  if(typeof raw[key]!=='string')continue;
  const alias=(raw[key] as string).normalize('NFKC').trim().replace(/^@/,'');
  // No email addresses, phone identifiers, URL queries, or free-form instructions.
  if(alias.length>=3&&alias.length<=100&&/^[\p{L}\p{N}_. -]+$/u.test(alias)&&/\p{L}/u.test(alias)&&!/(?:\D*\d){8}/.test(alias))return alias;
 }
 return null;
}
export function profileSearchQuery(raw:Record<string,unknown>):string|null {
 const alias=publicAlias(raw);return alias?'"'+alias+'" social profile creator':null;
}
function fold(s:string) {return s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
export function matchesPublicAlias(raw:Record<string,unknown>,r:SearchResult) {
 const alias=publicAlias(raw),profile=normalizeProfile(r.url);if(!alias||!profile)return false;
 const a=fold(alias);return fold(profile.handle).replaceAll(' ','')===a.replaceAll(' ','')||(' '+fold(r.title)+' ').includes(' '+a+' ');
}
export function createTavilyProfileSearch(apiKey:string,fetcher:typeof fetch=fetch):ProfileSearch {
 if(!apiKey?.trim())throw new Error('TAVILY_API_KEY is required when search is enabled.');
 return async(query,signal)=>{
  if(query.length>400)throw new Error('Profile query exceeds limit.');
  const response=await fetcher('https://api.tavily.com/search',{method:'POST',redirect:'error',
   signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
   body:JSON.stringify({query,search_depth:'basic',max_results:5,include_domains:domains,include_answer:false,include_raw_content:false,include_images:false,auto_parameters:false})});
  if(!response.ok||!response.body){await response.body?.cancel();throw new Error('PROFILE_SEARCH_FAILED');}
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;
   if(size>250000)throw new Error('PROFILE_SEARCH_TOO_LARGE');chunks.push(r.value);}}
  finally{await reader.cancel();reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!Array.isArray(data.results))throw new Error('PROFILE_SEARCH_INVALID');
  const results:SearchResult[]=[];
  for(const r of data.results.slice(0,5)) {
   const p=normalizeProfile(r?.url);if(p&&typeof r.title==='string')results.push({url:p.url,title:r.title.slice(0,300)});
  }
  return results;
 };
}
type SearchOutcome={results:SearchResult[];note:string|null;observedAt:Date};
/** Reserve budget before provider IO. An ambiguous request is never automatically rebilled. */
export async function searchProfilesWithinBudget(pool:Pool,job:LeasedJob,query:string,search:ProfileSearch,signal:AbortSignal,dailyLimit=100):Promise<SearchOutcome> {
 if(!Number.isSafeInteger(dailyLimit)||dailyLimit<1||dailyLimit>1000)throw new Error('Search daily limit must be 1–1000.');
 signal.throwIfAborted();
 const hash=createHash('sha256').update(query).digest('hex');
 const reservation=await withTransaction(pool,async client=>{
  if(!(await client.query(`SELECT 1 FROM jobs WHERE job_id=$1 AND status='leased' AND leased_by=$2 AND lease_token=$3
    AND lease_expires_at>clock_timestamp() FOR UPDATE`,[job.id,job.leasedBy,job.leaseToken])).rowCount)throw new JobExecutionError('ENRICHMENT_LEASE_LOST');
  await client.query('SELECT pg_advisory_xact_lock(19790426,103)');
  const {rows:[prior]}=await client.query('SELECT * FROM enrichment_search_requests WHERE job_id=$1',[job.id]);
  if(prior)return {call:false,results:prior.status==='complete'?prior.results:[],note:prior.status==='complete'?null:'SEARCH_OUTCOME_UNKNOWN',observedAt:prior.created_at};
  const {rows:[cached]}=await client.query(`SELECT * FROM enrichment_search_requests WHERE query_hash=$1 AND status='complete'
    AND created_at>clock_timestamp()-interval '7 days' ORDER BY created_at DESC LIMIT 1`,[hash]);
  if(cached)return {call:false,results:cached.results,note:null,observedAt:cached.created_at};
  if((await client.query(`SELECT 1 FROM enrichment_search_requests WHERE query_hash=$1 AND status='reserved' AND created_at>clock_timestamp()-interval '1 minute' LIMIT 1`,[hash])).rowCount)
    return {call:false,results:[],note:'SEARCH_ALREADY_IN_PROGRESS',observedAt:new Date()};
  const {rows:[usage]}=await client.query(`SELECT count(*)::integer AS n FROM enrichment_search_requests WHERE budget_day=(clock_timestamp() AT TIME ZONE 'Europe/Athens')::date`);
  if(usage.n>=dailyLimit)return {call:false,results:[],note:'SEARCH_DAILY_LIMIT',observedAt:new Date()};
  const {rows:[saved]}=await client.query(`INSERT INTO enrichment_search_requests(job_id,query_hash,status) VALUES($1,$2,'reserved') RETURNING created_at`,[job.id,hash]);
  return {call:true,results:[],note:null,observedAt:saved.created_at};
 });
 if(!reservation.call)return reservation;
 try{
  signal.throwIfAborted();
  const results=(await search(query,signal)).slice(0,5).filter(r=>normalizeProfile(r.url)&&typeof r.title==='string').map(r=>({url:r.url,title:r.title.slice(0,300)}));
  await pool.query("UPDATE enrichment_search_requests SET status='complete',results=$2 WHERE job_id=$1",[job.id,JSON.stringify(results)]);
  return {results,note:null,observedAt:reservation.observedAt};
 }catch{
  await pool.query("UPDATE enrichment_search_requests SET status='unknown' WHERE job_id=$1",[job.id]);
  signal.throwIfAborted();return {results:[],note:'SEARCH_OUTCOME_UNKNOWN',observedAt:reservation.observedAt};
 }
}
