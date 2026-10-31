import type { Metadata } from 'next';
import Link from 'next/link';
import { Navigation } from './navigation';
import './globals.css';
export const metadata: Metadata = {
  title: 'M²D · Move · Motive · Decision',
  description: 'A local-first investment decision workspace.',
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
            <p className="nav-label">Workspace</p>
            <Navigation />
            <div className="sidebar-note">
              Local workspace
              <p>Self-reported portfolio</p>
            </div>
          </aside>
          <div className="content">
            <header>
              <span>Personal workspace</span>
              <span className="badge">M0 · Foundation</span>
            </header>
            <main id="main">{children}</main>
            <footer>
              Local-first · No broker connections or order execution
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
