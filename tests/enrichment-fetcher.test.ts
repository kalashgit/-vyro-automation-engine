import assert from 'node:assert/strict';
import test from 'node:test';
import { officialUrl, publicIPv4, robotsAllows } from '../src/modules/enrichment/official-site-fetcher.ts';
import { visibleText } from '../src/modules/enrichment/pipeline.ts';

test('retrieval excludes private, metadata, multicast, reserved and IPv6 addresses',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.0.2','169.254.169.254','100.100.100.200',
    '0.0.0.0','192.0.0.1','198.18.0.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1'])
    assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('8.8.8.8'),true);
});
test('all redirects must remain on exact official domain with HTTPS and no credentials or custom ports',()=>{
  for(const url of ['http://shop.gr','https://evil.gr','https://shop.gr.evil.gr','https://user:secret@shop.gr',
    'https://shop.gr:8443','https://127.0.0.1','https://sub.shop.gr']) assert.throws(()=>officialUrl(url,'shop.gr'));
  assert.equal(officialUrl('https://www.shop.gr/contact#top','shop.gr').href,'https://www.shop.gr/contact');
});
test('robots disallow handles paths, wildcard, query and end anchors conservatively',()=>{
  const rules='User-agent: *\nDisallow: /private\nDisallow: /*?secret=\nDisallow: /exact$\nAllow: /private/open';
  for(const path of ['/private/open','/contact?secret=yes','/exact']) assert.equal(robotsAllows(rules,new URL('https://shop.gr'+path)),false,path);
  assert.equal(robotsAllows(rules,new URL('https://shop.gr/exactly')),true);
  assert.equal(robotsAllows('Disallow: /',new URL('https://shop.gr')),false);
  assert.equal(robotsAllows('Disallow:',new URL('https://shop.gr')),true);
});
test('visible evidence excludes scripts and decodes common public text entities',()=>{
  assert.equal(visibleText('<script>evil@shop.gr</script><style>hidden</style><p>A &amp; B info&#64;shop.gr</p>'),'A & B info@shop.gr');
});
