import { StatusPanel } from './status-panel';
import { PortfolioSummary } from './portfolio/portfolio-client';
import { ValuationPanel } from './market/valuation';
export default function Home() {
  return (
    <>
      <div className="page-heading">
        <h1>Dashboard</h1>
        <p className="intro">Your portfolio at a glance.</p>
      </div>
      <StatusPanel />
      <PortfolioSummary />
      <ValuationPanel />
      <section className="workspace-card activity-card">
        <div className="card-heading">
          <h2>Coming next</h2>
        </div>
        <p className="card-note">
          Research and filings arrive in M4. Risk planning and monitoring follow
          later. Portfolio records are self-reported; no orders are sent.
        </p>
      </section>
    </>
  );
}
