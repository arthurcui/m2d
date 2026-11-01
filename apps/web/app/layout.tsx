import type { Metadata } from 'next';
import Link from 'next/link';
import { Navigation } from './navigation';
import './globals.css';
import { PortfolioClient } from './portfolio/portfolio-client';
import { MarketDataProvider } from './market/market-context';
export const metadata: Metadata = {
  title: 'M²D · Move · Motive · Decision',
  description:
    'Track your portfolio, review changes, and keep a clear record of your investment decisions with M²D.',
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="shell">
          <aside>
            <Link className="brand" href="/">
              M<span>²</span>D
            </Link>
            <p className="wordmark">MOVE · MOTIVE · DECISION</p>
            <Navigation />
          </aside>
          <div className="content">
            <header>
              <span>Move · Motive · Decision</span>
              <span className="badge">M2 · Portfolio Agent</span>
            </header>
            <main id="main">
              <MarketDataProvider>
                <PortfolioClient>{children}</PortfolioClient>
              </MarketDataProvider>
            </main>
            <footer>
              <details>
                <summary>About M²D</summary>
                <p>
                  M²D tracks your portfolio, monitors the market, and provides
                  actionable trading recommendations with clear reasoning and
                  risk analysis.
                </p>
              </details>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
