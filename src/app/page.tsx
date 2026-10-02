import { getHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

const modules = [
  {
    title: "Queue Status",
    description: "Queue infrastructure is not connected.",
  },
  {
    title: "Workers",
    description: "Background workers are not implemented.",
  },
  {
    title: "Watchdog",
    description: "Worker monitoring is not configured.",
  },
] as const;

export default function Dashboard() {
  const health = getHealth();

  return (
    <main className="dashboard">
      <header className="page-header">
        <div className="identity">
          <span className="wordmark">VYRO</span>
          <span className="phase">PHASE 1 · FOUNDATION</span>
        </div>
        <h1>VYRO Automation Engine</h1>
        <p className="intro">
          Automation control plane for VYRO operations. This application is
          separate from the VYRO customer storefront.
        </p>
      </header>

      <section className="panel engine-status" aria-labelledby="engine-heading">
        <div>
          <p className="eyebrow">Control plane</p>
          <h2 id="engine-heading">
            Engine Status: <span className="online">ONLINE</span>
          </h2>
          <p className="muted">
            The web application is responding. Automation processing is not
            enabled in Phase 1.
          </p>
        </div>
        <a className="health-link" href="/api/health">
          View health JSON <span aria-hidden="true">↗</span>
        </a>
      </section>

      <section className="module-grid" aria-label="Automation module status">
        {modules.map((module) => (
          <article className="panel module" key={module.title}>
            <h2>{module.title}</h2>
            <p className="pending">NOT CONFIGURED</p>
            <p className="muted">{module.description}</p>
          </article>
        ))}
      </section>

      <section className="panel heartbeat" aria-labelledby="heartbeat-heading">
        <p className="eyebrow">HTTP liveness</p>
        <h2 id="heartbeat-heading">Last heartbeat</h2>
        <time dateTime={health.timestamp}>{health.timestamp}</time>
        <p className="muted">
          Timestamp of this control-plane response. Worker heartbeats will be
          connected in a future phase.
        </p>
      </section>

      <footer>
        <span>Foundation only · No automation jobs are executed.</span>
        <span>Version {health.version}</span>
      </footer>
    </main>
  );
}
