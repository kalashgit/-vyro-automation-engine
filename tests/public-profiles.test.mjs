import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProfile,profilesFromRecord,profilesFromPage,isSocialHost} from '../src/modules/enrichment/public-profiles.mjs';
test('canonicalizes explicit account routes, aliases and tracking parameters',()=>{
 for(const [input,output] of [
  ['http://www.instagram.com/Example/?utm_source=x','https://instagram.com/example/'],
  ['https://twitter.com/Example','https://x.com/example'],
  ['https://twitch.tv/Example','https://twitch.tv/example'],
  ['https://youtube.com/@Example','https://youtube.com/@example'],
  ['https://tiktok.com/@Example','https://tiktok.com/@example'],
  ['https://m.facebook.com/profile.php?id=123456&ref=x','https://facebook.com/profile.php?id=123456'],
  ['https://reddit.com/u/Example','https://reddit.com/user/example/'],
  ['https://steamcommunity.com/profiles/76561198000000000','https://steamcommunity.com/profiles/76561198000000000/'],
  ['https://linkedin.com/in/example','https://linkedin.com/in/example/']
 ])assert.equal(normalizeProfile(input)?.url,output);
});
test('rejects private routes, posts, invented handles and lookalike hosts',()=>{
 for(const input of ['@example','https://instagram.com/p/123','https://instagram.com/direct','https://twitch.tv/directory','https://facebook.com/profile.php','https://youtube.com/watch?v=1','https://reddit.com/r/gaming','https://instagram.com.evil.org/example','https://user:pass@twitch.tv/example','https://twitch.tv:444/example','javascript:alert(1)'])assert.equal(normalizeProfile(input),null,input);
 assert.equal(isSocialHost('m.facebook.com'),true);assert.equal(isSocialHost('twitch.tv'),true);
});
test('extracts only explicit field URLs and visible page links, deduplicated',()=>{
 assert.equal(profilesFromRecord({'Instagram':'@example','Entity':'https://twitch.tv/ignored'}).length,0);
 const p=profilesFromRecord({'Instagram':'https://instagram.com/example/?tracking=x','Website/Profile':'https://instagram.com/example/'});
 assert.equal(p.length,1);assert.equal(p[0].field,'Website/Profile');
 const page='<script>"<a href="https://twitch.tv/hidden">"</script><a href="https://twitch.tv/example">Twitch</a><a href="https://twitch.tv/example?x=y">Again</a>';
 assert.equal(profilesFromPage(page).length,1);assert.equal(profilesFromPage(page)[0].handle,'example');
});
