import type { Metadata } from 'next';
import Link from 'next/link';
import { Navigation } from './navigation';
import './globals.css';
import { PortfolioClient } from './portfolio/portfolio-client';
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
              <span className="badge">M1 · Portfolio</span>
            </header>
            <main id="main">
              <PortfolioClient>{children}</PortfolioClient>
            </main>
            <footer>
              <details>
                <summary>About M²D</summary>
                <p>
                  M²D helps you track your portfolio, review changes before they
                  take effect, and maintain a clear record of your investment
                  decisions.
                </p>
              </details>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
