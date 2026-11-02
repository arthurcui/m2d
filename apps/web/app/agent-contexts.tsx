'use client';
import { ChatMarkdown } from './chat-markdown';
import { useState, type KeyboardEvent } from 'react';

export function submitAgentOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return;
  event.preventDefault();
  if (
    event.repeat ||
    !event.currentTarget.value.trim() ||
    event.currentTarget.matches(':disabled')
  )
    return;
  event.currentTarget.form?.requestSubmit();
}

export const agentContexts = [
  { path: '/', label: 'Dashboard', milestone: 'later milestones' },
  { path: '/portfolio', label: 'Portfolio', milestone: 'M1' },
  { path: '/risk', label: 'Trade Planner', milestone: 'M5' },
  { path: '/market', label: 'Market & Watchlist', milestone: 'M3–M6' },
  { path: '/opportunities', label: 'Opportunities', milestone: 'M6' },
  { path: '/research', label: 'Research', milestone: 'M4' },
  { path: '/journal', label: 'Journal & Performance', milestone: 'M7' },
  { path: '/chat', label: 'General', milestone: 'M2' },
] as const;

// Keep every context mounted in the shared layout: route and panel visibility
// must never discard its messages or unsent draft.
export function PlannedAgentConversation({
  context,
  active,
}: {
  context: (typeof agentContexts)[number];
  active: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<{ text: string; at: string }[]>([]);
  return (
    <div hidden={!active} className="agent-context">
      <div role="log" aria-label={`${context.label} conversation`}>
        <div className="agent-message">
          <strong>Advisor</strong>
          <p>
            This is your {context.label} conversation. Keep questions and notes
            here for this session. Assistance for this function is planned for{' '}
            {context.milestone}; no AI analysis runs here in M1.
          </p>
        </div>
        {messages.map((message, index) => (
          <div key={index} className="agent-message from-user">
            <strong>You</strong>
            <ChatMarkdown text={message.text} />
            <time className="muted-label" dateTime={message.at}>
              {new Intl.DateTimeFormat('en-CA', {
                timeZone: 'America/Vancouver',
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(message.at))}
            </time>
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          setMessages((old) => [
            ...old,
            { text: draft.trim(), at: new Date().toISOString() },
          ]);
          setDraft('');
        }}
      >
        <label>
          {context.label} draft
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={submitAgentOnEnter}
            maxLength={4000}
            placeholder={`Keep a question or note for ${context.label}`}
          />
        </label>
        <p className="muted-label">
          Enter to send · Shift+Enter for a new line. Saved notes and drafts
          stay in this conversation while you navigate. Notes do not start
          analysis or change your portfolio.
        </p>
        <button type="submit" disabled={!draft.trim()}>
          Save note
        </button>
      </form>
    </div>
  );
}
