import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTavilyProfileSearch,profileSearchQuery,matchesPublicAlias} from '../src/modules/enrichment/profile-search.ts';
test('searches public aliases only, excludes email and phone identifiers',()=>{
 assert.equal(profileSearchQuery({Email:'user@example.org',Phone:'+302101234567'}),null);
 assert.equal(profileSearchQuery({Entity:'user@example.org'}),null);
 assert.equal(profileSearchQuery({Handle:'@GameAlias'}),'"GameAlias" social profile creator');
 assert.equal(profileSearchQuery({Name:'2101234567'}),null);
 assert.equal(matchesPublicAlias({Entity:'Game Alias'},{url:'https://twitch.tv/gamealias',title:'Twitch'}),true);
 assert.equal(matchesPublicAlias({Entity:'Game Alias'},{url:'https://twitch.tv/other',title:'Game Alias | Twitch'}),true);
 assert.equal(matchesPublicAlias({Entity:'Game Alias'},{url:'https://twitch.tv/other',title:'Some Other Account'}),false);
});
test('bounded provider requests filter account URLs and ignore provider relevance as ownership evidence',async()=>{
 const search=createTavilyProfileSearch('fixture-key',async(input,init)=>{
  assert.equal(input,'https://api.tavily.com/search');assert.equal(init?.redirect,'error');
  const body=JSON.parse(String(init?.body));assert.equal(body.search_depth,'basic');assert.equal(body.max_results,5);
  assert.equal(body.include_answer,false);assert.equal(body.include_raw_content,false);assert.equal(body.auto_parameters,false);
  assert.ok(body.include_domains.includes('twitch.tv'));
  return Response.json({results:[{url:'https://twitter.com/GameAlias',title:'GameAlias',score:0.99},{url:'https://evil.example/GameAlias',title:'GameAlias'},{url:'https://instagram.com/p/post',title:'GameAlias'}]});
 });
 assert.deepEqual(await search('GameAlias',new AbortController().signal),[{url:'https://x.com/gamealias',title:'GameAlias'}]);
});
test('missing credentials, failed responses and oversized bodies fail explicitly',async()=>{
 assert.throws(()=>createTavilyProfileSearch(''));
 const signal=new AbortController().signal;
 await assert.rejects(createTavilyProfileSearch('fixture',async()=>new Response('secret details',{status:429}))('alias',signal),/PROFILE_SEARCH_FAILED/);
 await assert.rejects(createTavilyProfileSearch('fixture',async()=>new Response('x'.repeat(250001)))('alias',signal),/PROFILE_SEARCH_TOO_LARGE/);
});
