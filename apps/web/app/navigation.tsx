'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
const navigation = [
  ['Dashboard', '/', 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'],
  ['Portfolio', '/portfolio', 'M4 21V12h4v9 M10 21V7h4v14 M16 21V3h4v18'],
  [
    'Trade Planner',
    '/risk',
    'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7z M12 8v6 M12 17h.01',
  ],
  [
    'Market & Watchlist',
    '/market',
    'm12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
  ],
  [
    'Opportunities',
    '/opportunities',
    'M9 18h6 M9 21h6 M8 14a7 7 0 1 1 8 0l-1 3H9z',
  ],
  ['Research', '/research', 'M4 3h12l4 4v14H4z M16 3v5h4 M8 12h8 M8 16h8'],
  ['Journal & Performance', '/journal', 'M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5'],
  ['Chat', '/chat', 'M3 4h18v13H9l-6 4z'],
] as const;
const shortNames = [
  'Overview',
  'Portfolio',
  'Trade Planner',
  'Market',
  'Ideas',
  'Research',
  'Journal',
  'Advisor',
];
export function Navigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main navigation">
      {navigation.map(([label, href, path], i) => (
        <Link
          key={href}
          href={href}
          aria-label={label}
          title={label}
          aria-current={pathname === href ? 'page' : undefined}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={path} />
          </svg>
          <span>{shortNames[i]}</span>
        </Link>
      ))}
    </nav>
  );
}
