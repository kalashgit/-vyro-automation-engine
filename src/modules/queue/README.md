# Queue

Implemented durable PostgreSQL lifecycle primitives in `queue.ts` and typed contracts in `types.ts`. See [design](../../../docs/persistent-queue.md).

No worker dispatcher, polling loop, or outbound handler is started by this module.
