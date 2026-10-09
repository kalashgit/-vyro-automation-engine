# Creator and consumer account enrichment

`social_profiles` preserves explicit social account URLs from imported fields and
optionally discovers account links on the prospect's recorded website. It supports
Instagram, Facebook, YouTube, TikTok, Twitch, X/Twitter, Reddit, LinkedIn, Steam
and Linktree. Account routes are review evidence, not proof of ownership or of an
active account, open DMs, consent, or delivery. No messages are sent.

Social-only intake can use an exact account URL as its identity without a country
or company website. Identical names on different accounts stay separate. Repeated
canonical account URLs create identity conflicts; records are never silently merged.
Business-domain behavior remains unchanged. Imported public emails continue through
the existing official-site/email workflow.

## Operate

Provide database variables in the process environment, then:

```sh
npm run db:migrate
node --experimental-strip-types scripts/index-profile-routes.mjs
node --experimental-strip-types scripts/index-profile-routes.mjs --apply --recover-deferred
```

The index processes at most 5,000 import rows per invocation. Repeat if `remaining`
is nonzero. It includes raw rows not promoted to prospects, so cross-record account
collisions cannot evade detection simply by remaining in the raw ledger. New imports
index their account links in the same transaction. Recovery preserves original IDs
and source batch links, creates unchecked prospects for previously deferred account
rows, and queues local identity reconciliation. Start the acquisition worker to
reconcile those before selecting enrichment jobs:

```sh
WORKER_ENABLED=true ACQUISITION_HANDLERS_ENABLED=true SOCIAL_ENRICHMENT_ENABLED=true npm run worker
```

For account-link collection from recorded websites, additionally set
`ENRICHMENT_ENABLED=true`. Keep one collector worker; the existing bounded HTTPS,
robots and cancellation controls apply. Social platform pages are not scraped.

Preview and enqueue the existing certified prospect population:

```sh
node --experimental-strip-types scripts/enrich-contacts.mjs --mode social_profiles --campaign social-20261009 --limit 4000
node --experimental-strip-types scripts/enrich-contacts.mjs --mode social_profiles --campaign social-20261009 --limit 4000 --apply
```

Optional `--category B2C` or `--category CRE` selects a category. The maximum social
batch is 5,000; website/email mode keeps its 100-record limit. Same campaign/record
keys are idempotent. Active jobs and runs completed in the past seven days are
excluded. For an explicitly selected retry after correcting source/configuration,
use `--record-id ...` and a new campaign label. A partial enqueue can be resumed with
the same command. Suppressed/irrelevant prospects and pending identity conflicts
are excluded.

Visit `/enrichment` using the existing admin authentication. Results show profiles,
provenance, duplicate record IDs, needs-review notes and queue counts. Pagination is
50 records. An imported URL keeps its original import timestamp; it is not reported
as freshly verified. The JSON read endpoint is `/api/enrichment?offset=0`.

## Reliability and remaining operational work

Jobs commit evidence and run outcomes atomically, fenced by the current worker lease.
Committed jobs replay without repeating collection. Observations are append-only.
Profile collision checks include indexed original ledger rows, current prospect
identities and prior enrichment evidence; global advisory locks serialize the latter.
Older observations are snapshots: a later duplicate may appear on a later run rather
than rewriting the earlier audit. Never use a `profiles_found` outcome alone as
outreach eligibility.

Records lacking explicit account links or an accessible recorded website receive
`MANUAL_PROFILE_RESEARCH_REQUIRED`. Web-wide alias search and identity matching are
not implemented in this version. The system does not guess account ownership from
names, infer personal emails/phone numbers, or claim complete enrichment coverage.

Production migrations, database configuration, persistent-worker activation and a
real-data batch still need to be performed on the operator's environment. Synthetic
integration tests do not mean the real prospect population has been processed.

After this enrichment increment, development priority is outreach: connect the
sender worker to verified eligible recipients, record provider outcomes, process
replies/bounces/unsubscribes, enforce quotas and suppression, and measure results.
Social account links remain manual routes until a supported channel integration is
explicitly configured. Outreach activation and campaign content require actual
provider/sender configuration; this change does not enable sending.
