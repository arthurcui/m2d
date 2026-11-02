import { notFound } from 'next/navigation';
import Link from 'next/link';
const sections: Record<
  string,
  { title: string; milestone: string; description: string }
> = {
  portfolio: {
    title: 'Portfolio',
    milestone: 'M1',
    description:
      'Manually recorded accounts, positions, cash, and confirmed full-state Excel imports.',
  },
  risk: {
    title: 'Trade Planner',
    milestone: 'M5',
    description:
      'Option obligations, exposure, coverage, and deterministic risk scenarios.',
  },
  market: {
    title: 'Market & Watchlist',
    milestone: 'M3–M6',
    description:
      'Timestamped market evidence, explicit data quality, and watched instruments.',
  },
  opportunities: {
    title: 'Opportunities',
    milestone: 'M6',
    description:
      'Conditional trade plans with evidence, invalidation conditions, and primary risks.',
  },
  research: {
    title: 'Research',
    milestone: 'M4',
    description:
      'Original documents, point-in-time facts, and cited company research.',
  },
  journal: {
    title: 'Journal & Performance',
    milestone: 'M7',
    description:
      'Self-reported trades and honest performance coverage, separated from hypothetical fills.',
  },
  chat: {
    title: 'Chat',
    milestone: 'M2',
    description:
      'Provider-neutral inference, natural-language previews, and Quick / Standard / Extensive analysis.',
  },
};
export default async function Placeholder({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const item = sections[section];
  if (!item) notFound();
  return (
    <>
      <div className="eyebrow">
        {section === 'chat' ? 'AVAILABLE' : 'PLANNED'} · {item.milestone}
      </div>
      <h1>{item.title}</h1>
      <p className="intro">{item.description}</p>
      <section className="empty-state">
        <div>
          <h2>
            {section === 'chat'
              ? 'Talk with Advisor'
              : 'Coming in a later milestone'}
          </h2>
          <p>
            Use the Advisor panel for questions about your recorded portfolio.
            No market data has been retrieved.
          </p>
          <p>
            Advisor saves a separate conversation for this function. Currently,
            portfolio assistance is available in the Portfolio conversation;
            your unfinished work is preserved while you navigate.
          </p>
          <Link className="back" href="/">
            ← Back to dashboard
          </Link>
        </div>
      </section>
    </>
  );
}
