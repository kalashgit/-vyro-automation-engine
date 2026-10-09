// Explicit public account URLs only. A URL observation is not ownership or DM verification.
const hosts = new Set(['instagram.com','facebook.com','youtube.com','tiktok.com','twitch.tv','x.com','twitter.com','reddit.com','linkedin.com','steamcommunity.com','linktr.ee']);
const reserved = new Set(['p','reel','reels','stories','explore','accounts','direct','login','signup','search','watch','videos','groups','events','marketplace','share','sharer.php','profile.php','home','intent','i','settings','directory','downloads','privacy','terms','about','help','jobs','feed','gaming']);
export function isSocialHost(host) {
  const h=host.toLowerCase().replace(/^(www|m|mobile)\./,'');
  return hosts.has(h)||['youtu.be','wa.me','maps.google.com','discord.com','discord.gg'].includes(h);
}
export function normalizeProfile(value) {
  if(typeof value!=='string'||value.length>2048||!/^https?:\/\//i.test(value.trim())) return null;
  try {
    const u=new URL(value.trim());
    if(u.username||u.password||u.port) return null;
    let host=u.hostname.toLowerCase().replace(/^(www|m|mobile)\./,'');
    if(!hosts.has(host)) return null;
    if(host==='twitter.com') host='x.com';
    const parts=u.pathname.split('/').filter(Boolean);
    const one=parts.length===1 && /^[a-zA-Z0-9_.-]{1,100}$/.test(parts[0]) && !reserved.has(parts[0].toLowerCase());
    let path,handle,platform;
    if(['instagram.com','facebook.com','twitch.tv','x.com','linktr.ee'].includes(host)&&one) {
      handle=parts[0].toLowerCase(); path='/'+handle+(host==='instagram.com'?'/':'');
      platform=({'instagram.com':'instagram','facebook.com':'facebook','twitch.tv':'twitch','x.com':'x','linktr.ee':'linktree'})[host];
    } else if(host==='facebook.com' && u.pathname==='/profile.php' && /^\d{5,30}$/.test(u.searchParams.get('id')??'')) {
      handle=u.searchParams.get('id');path='/profile.php?id='+handle;platform='facebook';
    } else if(['youtube.com','tiktok.com'].includes(host)&&parts.length===1&&/^@[a-zA-Z0-9_.-]{1,100}$/.test(parts[0])) {
      handle=parts[0].slice(1).toLowerCase(); path='/@'+handle;platform=host==='youtube.com'?'youtube':'tiktok';
    } else if(host==='youtube.com'&&parts.length===2&&parts[0]==='channel'&&/^UC[a-zA-Z0-9_-]{22}$/.test(parts[1])) {
      handle=parts[1];path='/channel/'+handle;platform='youtube';
    } else if(host==='reddit.com'&&parts.length===2&&['u','user'].includes(parts[0])&&/^[a-zA-Z0-9_-]{3,30}$/.test(parts[1])) {
      handle=parts[1].toLowerCase();path='/user/'+handle+'/';platform='reddit';
    } else if(host==='linkedin.com'&&parts.length===2&&['in','company'].includes(parts[0])&&/^[a-zA-Z0-9_-]{1,100}$/.test(parts[1])) {
      handle=parts[1].toLowerCase();path='/'+parts[0]+'/'+handle+'/';platform='linkedin';
    } else if(host==='steamcommunity.com'&&parts.length===2&&['id','profiles'].includes(parts[0])&&/^[a-zA-Z0-9_-]{1,100}$/.test(parts[1])&&(parts[0]!=='profiles'||/^\d{17}$/.test(parts[1]))) {
      // Custom Steam vanity URLs are preserved rather than assuming case-insensitivity.
      handle=parts[1];path='/'+parts[0]+'/'+handle+'/';platform='steam';
    } else return null;
    return {url:'https://'+host+path,platform,handle};
  } catch {return null;}
}
const fields=['Website/Profile','Profile URL','Account URL','Instagram','Facebook','YouTube','Youtube','TikTok','Tiktok','Twitch','Twitter','X','Reddit','LinkedIn','Steam','Source URL'];
export function profilesFromRecord(raw) {
  const found=new Map();
  for(const field of fields) {
    if(typeof raw?.[field]!=='string') continue;
    for(const match of raw[field].slice(0,10000).matchAll(/https?:\/\/[^\s<>"',;]+/gi)) {
      const p=normalizeProfile(match[0]); if(p&&!found.has(p.url)) found.set(p.url,{...p,field});
    }
  }
  return [...found.values()].slice(0,30);
}
export function profilesFromPage(html) {
  const found=new Map();
  const body=html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  for(const m of body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const p=normalizeProfile(m[1].replace(/&amp;/g,'&')); if(p)found.set(p.url,p);
  }
  return [...found.values()].slice(0,30);
}
export async function indexImportedProfiles(client,importRowId,recordId,raw) {
  for(const p of profilesFromRecord(raw)) await client.query(`INSERT INTO import_profile_routes(import_row_id,record_id,canonical_url,platform,handle)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[importRowId,recordId,p.url,p.platform,p.handle]);
  await client.query('INSERT INTO profile_indexed_rows(import_row_id) VALUES($1) ON CONFLICT DO NOTHING',[importRowId]);
}
