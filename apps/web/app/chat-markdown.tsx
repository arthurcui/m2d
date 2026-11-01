import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';

/** Untrusted messages: no raw HTML, automatic remote images, or unsafe URLs. */
export function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            !href ? (
              <span>{children}</span>
            ) : href.startsWith('/') && !href.startsWith('//') ? (
              <Link href={href}>{children}</Link>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          img: ({ alt }) => <span>{alt ?? 'Image'}</span>,
          table: ({ children }) => (
            <div
              className="chat-table-scroll"
              role="region"
              aria-label="Message table"
              tabIndex={0}
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
