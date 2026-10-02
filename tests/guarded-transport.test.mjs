import test from 'node:test';
import assert from 'node:assert/strict';
import { sendGuardedOutreach } from '../src/modules/outreach/guarded-transport.mjs';

const email = 'buyer@example.com';
const prospect = { identity_status: 'certified', verification_status: 'verified', suppression_status: 'passed', relevance_status: 'relevant', contactability_status: 'contactable' };
const contacts = [{ channel: 'email', value: email, verification_status: 'verified', source_url: 'https://example.com/contact' }];
const env = { OUTREACH_SENDING_ENABLED: 'true', UNSUBSCRIBE_SECRET: 'x'.repeat(48), PUBLIC_APP_ORIGIN: 'https://example.com', VYRO_REPLY_TO: 'owner@icloud.com' };
test('disabled by default and never calls transport', async () => {
 let calls=0;
 await assert.rejects(sendGuardedOutreach({email,prospect,contacts,db:{query:async()=>({rows:[]})},subject:'Hello',bodyText:'Test',send:()=>{calls++;},environment:{}}), /OUTREACH_SENDING_DISABLED/);
 assert.equal(calls,0);
});
test('verified recipient gets signed unsubscribe and iCloud reply-to', async () => {
 let payload;
 await sendGuardedOutreach({email,prospect,contacts,db:{query:async()=>({rows:[]})},subject:'Hello',bodyText:'Test',send:async p=>{payload=p;return {id:'test'};},environment:env});
 assert.deepEqual(payload.to,[email]);
 assert.equal(payload.reply_to,'owner@icloud.com');
 assert.match(payload.html,/unsubscribe\?token=/);
});
test('suppressed recipient never reaches transport', async () => {
 let calls=0;
 await assert.rejects(sendGuardedOutreach({email,prospect,contacts,db:{query:async()=>({rows:[{exists:1}]})},subject:'Hello',bodyText:'Test',send:()=>{calls++;},environment:env}),/EMAIL_SUPPRESSED/);
 assert.equal(calls,0);
});
test('database errors fail closed', async () => {
 let calls=0;
 await assert.rejects(sendGuardedOutreach({email,prospect,contacts,db:{query:async()=>{throw Error('db down');}},subject:'Hello',bodyText:'Test',send:()=>{calls++;},environment:env}),/db down/);
 assert.equal(calls,0);
});
