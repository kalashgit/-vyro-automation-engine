# Database

Typed PostgreSQL pools and a transactional checksum-protected migration runner are implemented. SQL lives in `migrations/`; apply it explicitly using `npm run db:migrate`.

The module does not provision a hosted database, run startup migrations, or import production prospects. See [deployment and integrity](../../../docs/persistent-queue.md).
