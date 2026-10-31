'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
const navigation = [
  ['Dashboard', '/'],
  ['Portfolio', '/portfolio'],
  ['Options & Risk', '/risk'],
  ['Market & Watchlist', '/market'],
  ['Opportunities', '/opportunities'],
  ['Research', '/research'],
  ['Journal & Performance', '/journal'],
  ['Chat', '/chat'],
] as const;
export function Navigation() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main navigation">
      {navigation.map(([label, href]) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? 'page' : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
