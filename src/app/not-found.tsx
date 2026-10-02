import Link from "next/link";

export default function NotFound() {
  return (
    <main className="dashboard">
      <p className="eyebrow">VYRO Automation Engine</p>
      <h1>Page not found</h1>
      <p className="intro">This control-plane route does not exist.</p>
      <p><Link href="/">Return to dashboard</Link></p>
    </main>
  );
}
