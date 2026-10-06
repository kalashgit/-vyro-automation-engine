import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeHost } from './public-email-extractor.ts';
import { JobExecutionError } from '../workers/worker.ts';

export interface FetchedPage { url: string; text: string; fetchedAt: Date; }
export type PageCollector = (domain: string, signal: AbortSignal) => Promise<FetchedPage[]>;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],
  ['224.0.0.0',4],['240.0.0.0',4],['192.88.99.0',24],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
export function publicIPv4(address: string): boolean {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}
export function officialUrl(value: string, domain: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new JobExecutionError('INVALID_SOURCE_URL',{retryable:false}); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      isIP(url.hostname) || normalizeHost(url.hostname) !== normalizeHost(domain) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain) || domain.length > 253 || value.length > 2048)
    throw new JobExecutionError('UNSAFE_SOURCE_URL',{retryable:false});
  url.hash = '';
  return url;
}

// DNS answers are checked and pinned to the actual TLS socket; redirects repeat checks.
// IPv6-only sites are deliberately deferred rather than weakening address validation.
async function read(url: URL, signal: AbortSignal): Promise<{status:number; location?:string; text:string}> {
  signal.throwIfAborted();
  const addresses = await lookup(url.hostname, {all:true, family:4});
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address)))
    throw new JobExecutionError('NON_PUBLIC_SOURCE_ADDRESS',{retryable:false});
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent:false, signal, headers:{'User-Agent':'VYROEnrichment/1.0', Accept:'text/html,text/plain', 'Accept-Encoding':'identity'},
      lookup: (_host, options, callback) => {
        const selected=addresses[0];
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, 4);
      },
    }, res => {
      const status=res.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status)) { res.destroy(); resolve({status,location:res.headers.location,text:''}); return; }
      if (status !== 200) { res.destroy(); resolve({status,text:''}); return; }
      if (!/^(text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/i.test(res.headers['content-type'] ?? '') ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy(); reject(new JobExecutionError('UNSUPPORTED_SOURCE_CONTENT',{retryable:false})); return;
      }
      const chunks: Buffer[]=[]; let size=0;
      res.on('data', (chunk:Buffer) => {
        size+=chunk.length;
        if (size>1_000_000) req.destroy(new JobExecutionError('SOURCE_TOO_LARGE',{retryable:false}));
        else chunks.push(chunk);
      });
      res.on('error',reject);
      res.on('end',()=>resolve({status,text:Buffer.concat(chunks).toString('utf8')}));
    });
    const timer=setTimeout(()=>req.destroy(new JobExecutionError('SOURCE_TIMEOUT')),10_000);
    req.on('close',()=>clearTimeout(timer));
    req.on('error',reject);
    req.end();
  });
}

/** Conservative policy: honor every Disallow, including other agents' groups.
 * Allow overrides are intentionally ignored. Ambiguous robots rules defer the site.
 */
export function robotsAllows(text: string, url: URL): boolean {
  for (const line of text.split(/\r?\n/)) {
    const match=line.replace(/#.*/, '').match(/^\s*disallow\s*:\s*(.*?)\s*$/i);
    if (!match || !match[1]) continue;
    const rule=match[1];
    if (!rule.startsWith('/')) return false;
    const pattern=rule.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*').replace(/\\\$$/,'$');
    if (new RegExp('^'+pattern).test(url.pathname+url.search)) return false;
  }
  return true;
}
async function fetchPage(url: URL, domain:string, signal:AbortSignal, robots?:string) {
  for(let i=0;i<4;i++) {
    if(robots!==undefined && !robotsAllows(robots,url)) throw new JobExecutionError('ROBOTS_DISALLOWED',{retryable:false});
    const result=await read(url,signal);
    if([301,302,303,307,308].includes(result.status)) {
      if(!result.location) throw new JobExecutionError('INVALID_REDIRECT',{retryable:false});
      url=officialUrl(new URL(result.location,url).href,domain); continue;
    }
    if(result.status===429 || result.status>=500) throw new JobExecutionError('SOURCE_TEMPORARILY_UNAVAILABLE');
    return {...result,url:url.href,fetchedAt:new Date()};
  }
  throw new JobExecutionError('TOO_MANY_REDIRECTS',{retryable:false});
}
export const collectOfficialPages: PageCollector = async (domain, parentSignal) => {
  const signal=AbortSignal.any([parentSignal,AbortSignal.timeout(45_000)]);
  const root=officialUrl('https://'+domain+'/',domain);
  const robots=await fetchPage(new URL('/robots.txt',root),domain,signal);
  if(robots.status!==200 && robots.status!==404) throw new JobExecutionError('ROBOTS_UNAVAILABLE',{retryable:false});
  const policy=robots.status===200?robots.text:'';
  await delay(1000,undefined,{signal});
  const home=await fetchPage(root,domain,signal,policy);
  if(home.status!==200) throw new JobExecutionError('SOURCE_NOT_ACCESSIBLE',{retryable:false});
  const pages:FetchedPage[]=[home];
  const links=new Set<string>();
  for(const match of home.text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url=officialUrl(new URL(match[1].replaceAll('&amp;','&'),home.url).href,domain);
      if(/contact|about|epikoin|επικοινων/i.test(decodeURI(url.pathname)) && !url.search && robotsAllows(policy,url)) links.add(url.href);
    } catch { /* Foreign or malformed links are not crawl targets. */ }
  }
  for(const link of [...links].sort().slice(0,2)) {
    signal.throwIfAborted();
    await delay(1000,undefined,{signal});
    // At most three content pages per job; sequential requests, no unbounded crawl.
    const page=await fetchPage(new URL(link),domain,signal,policy);
    if(page.status===200 && !pages.some(p=>p.url===page.url)) pages.push(page);
  }
  return pages;
};
