import { StatusPanel } from './status-panel';

export default function Home() {
  return (
    <>
      <div className="page-heading">
        <h1>Dashboard</h1>
        <p className="intro">Your portfolio and workspace at a glance.</p>
      </div>
      <StatusPanel />
      <div className="dashboard-grid">
        <section
          className="workspace-card portfolio-card"
          aria-labelledby="portfolio-title"
        >
          <div className="card-heading">
            <h2 id="portfolio-title">Portfolio overview</h2>
            <span className="badge">Not available yet</span>
          </div>
          <div className="portfolio-empty">
            <svg
              className="empty-icon"
              viewBox="0 0 48 48"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="8" y="11" width="32" height="29" rx="4" />
              <path d="M18 11V8a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v3M8 23h32M20 23v5h8v-5" />
            </svg>
            <h3>No portfolio records</h3>
            <p>
              Accounts, holdings, and cash will appear here.
              <br />
              Portfolio entry and Excel imports arrive in M1.
            </p>
          </div>
          <div className="card-note">
            Valuation and performance are unavailable until portfolio and market
            data are added.
          </div>
        </section>
        <section
          className="workspace-card"
          aria-labelledby="availability-title"
        >
          <div className="card-heading">
            <h2 id="availability-title">Workspace availability</h2>
          </div>
          <ul className="availability-list">
            <li>
              <div>
                <h3>Portfolio records</h3>
                <p>Accounts, holdings, and confirmed imports</p>
              </div>
              <span className="milestone">M1</span>
            </li>
            <li>
              <div>
                <h3>Chat & analysis</h3>
                <p>Natural-language previews and analysis modes</p>
              </div>
              <span className="milestone">M2</span>
            </li>
            <li>
              <div>
                <h3>Market data</h3>
                <p>Prices, sources, and valuation</p>
              </div>
              <span className="milestone">M3</span>
            </li>
          </ul>
          <div className="card-note">
            Only system health and the offline demo scheduler are active in M0.
          </div>
        </section>
      </div>
      <section
        className="workspace-card activity-card"
        aria-labelledby="activity-title"
      >
        <div className="card-heading">
          <h2 id="activity-title">Portfolio activity</h2>
          <span className="muted-label">Not available in M0</span>
        </div>
        <div className="activity-empty">
          <p>No portfolio activity to display.</p>
          <span>
            Confirmed changes will appear here when portfolio recording is
            available.
          </span>
        </div>
      </section>
    </>
  );
}
