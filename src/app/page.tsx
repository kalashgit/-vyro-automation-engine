import Link from "next/link";
import { getHealth } from "@/lib/health";
import { getControlPlaneSnapshot } from "@/modules/monitoring/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const unavailableModules = [
  { title: "Workers", description: "An independent persistent worker has not been deployed and tested." },
  { title: "Watchdog", description: "Independent worker monitoring is not configured." },
] as const;
export default async function Dashboard() {
  const snapshot = await getControlPlaneSnapshot();
  const health = getHealth();
  const queueStatus = snapshot.database === "ready" ? "CONNECTED" : snapshot.database === "not_configured" ? "NOT CONFIGURED" : "UNAVAILABLE";
  return (
    <main className="dashboard">
      <header className="page-header">
        <div className="identity"><span className="wordmark">VYRO</span><span className="phase">PHASE 2 · PERSISTENCE MILESTONE</span></div>
        <h1>VYRO Automation Engine</h1>
        <Link href="/enrichment">Review enrichment results</Link>
        <p className="intro">Automation control plane for VYRO operations. This application is separate from the VYRO customer storefront.</p>
      </header>
      <section className="panel engine-status" aria-labelledby="engine-heading">
        <div>
          <p className="eyebrow">Control plane</p>
          <h2 id="engine-heading">Engine Status: <span className="pending">NOT OPERATIONAL</span></h2>
          <p className="muted">Web application: <span className="online">ONLINE</span>. Continuous automation requires a deployed database and an independently hosted, tested worker. No outbound messaging is enabled.</p>
        </div>
        <a className="health-link" href="/api/health">View health JSON <span aria-hidden="true">↗</span></a>
      </section>
      <section className="module-grid" aria-label="Automation module status">
        <article className="panel module">
          <h2>Queue Status</h2><p className="pending">{queueStatus}</p>
          {snapshot.queue ? <>
            <dl className="queue-counts">
              <div><dt>Pending</dt><dd>{snapshot.queue.queued + snapshot.queue.retry}</dd></div>
              <div><dt>Ready</dt><dd>{snapshot.queue.ready}</dd></div>
              <div><dt>Leased</dt><dd>{snapshot.queue.leased}</dd></div>
              <div><dt>Retry</dt><dd>{snapshot.queue.retry}</dd></div>
              <div><dt>Failed / dead</dt><dd>{snapshot.queue.dead}</dd></div>
              <div><dt>Succeeded</dt><dd>{snapshot.queue.succeeded}</dd></div>
            </dl>
            <p className="muted">Counts read from PostgreSQL. Pending includes queued and scheduled retries. Expired leases: {snapshot.queue.expiredLeases}.</p>
          </> : <p className="muted">{snapshot.database === "not_configured" ? "Configure PostgreSQL and apply migrations to view queue counts." : "Database status could not be verified. Check database configuration and migrations."}</p>}
        </article>
        {unavailableModules.map((module) => <article className="panel module" key={module.title}><h2>{module.title}</h2><p className="pending">NOT CONFIGURED</p><p className="muted">{module.description}</p></article>)}
      </section>
      <section className="panel heartbeat" aria-labelledby="heartbeat-heading">
        <p className="eyebrow">HTTP liveness</p><h2 id="heartbeat-heading">Last heartbeat</h2>
        <time dateTime={health.timestamp}>{health.timestamp}</time>
        <p className="muted">Timestamp of this control-plane response. This is not a worker heartbeat. Worker heartbeats are not configured.</p>
      </section>
      <footer><span>Persistence milestone · Independent worker not configured.</span><span>Version {health.version}</span></footer>
    </main>
  );
}
