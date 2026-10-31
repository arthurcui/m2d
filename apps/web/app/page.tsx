import { StatusPanel } from './status-panel';
import { PortfolioSummary } from './portfolio/portfolio-client';
export default function Home() {
  return (
    <>
      <div className="page-heading">
        <h1>Dashboard</h1>
        <p className="intro">Your portfolio at a glance.</p>
      </div>
      <StatusPanel />
      <PortfolioSummary />
      <section className="workspace-card activity-card">
        <div className="card-heading">
          <h2>Coming next</h2>
        </div>
        <p className="card-note">
          Chat and natural-language updates arrive in M2. Market prices and
          valuation arrive in M3. Portfolio records are self-reported; no orders
          are sent.
        </p>
      </section>
    </>
  );
}
