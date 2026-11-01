'use client';
import { useState } from 'react';
export function SecurityLogo({
  url,
  name,
  fund,
}: {
  url: string | null;
  name: string;
  fund: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="security-logo"
      title={url && !failed ? name : `${name} · logo unavailable`}
    >
      {url && !failed ? (
        // Cached, validated image endpoint; no third-party requests or exposed provider keys.
        <img
          src={url}
          alt={`${name} logo`}
          width={30}
          height={30}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          {fund ? (
            <>
              <rect x="4" y="4" width="6" height="6" rx="1" />
              <rect x="14" y="4" width="6" height="6" rx="1" />
              <rect x="4" y="14" width="6" height="6" rx="1" />
              <rect x="14" y="14" width="6" height="6" rx="1" />
            </>
          ) : (
            <>
              <path d="M5 21V7l7-4 7 4v14M3 21h18M9 9h1m4 0h1M9 13h1m4 0h1M10 21v-4h4v4" />
            </>
          )}
        </svg>
      )}
    </span>
  );
}
