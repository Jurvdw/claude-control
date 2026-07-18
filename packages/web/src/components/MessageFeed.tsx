import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useServer } from '../state/ServerContext';
import { useAuth } from '../state/AuthContext';
import { reactions as reactionsApi } from '../lib/api';
import type { Message, MessageFile } from '../lib/types';
import { fmtBytes } from '../lib/format';
import PlanCard from './PlanCard';
import QuestionCard from './QuestionCard';
import EmailDraftCard from './EmailDraftCard';
import { Avatar, relTime } from './ui';

function fileIcon(mime: string, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime === 'application/pdf' || ext === 'pdf') return '📕';
  if (/(^| )(ppt|pptx|odp)$/.test(ext) || mime.includes('presentation')) return '📊';
  if (/(doc|docx|odt)$/.test(ext) || mime.includes('word')) return '📘';
  if (/(xls|xlsx|ods|csv)$/.test(ext) || mime.includes('sheet') || mime.includes('excel')) return '📗';
  if (/(zip|rar|7z|tar|gz)$/.test(ext)) return '🗜️';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('text/') || /(txt|md|json|csv|log|ts|js|py)$/.test(ext)) return '📄';
  return '📎';
}

// Inline attachment: image thumbnail, or a downloadable file card.
function Attachment({ file }: { file: MessageFile }) {
  if (/^image\//.test(file.mimeType)) {
    return (
      <a href={file.url} target="_blank" rel="noreferrer" className="block">
        <img src={file.url} alt={file.name} loading="lazy"
          className="max-h-60 max-w-xs rounded-lg border border-ink-700 object-contain bg-ink-900" />
      </a>
    );
  }
  return (
    <a href={file.url} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-2.5 px-3 py-2 rounded-lg bg-ink-800 border border-ink-700 hover:border-clay transition-colors max-w-xs">
      <span className="text-lg shrink-0">{fileIcon(file.mimeType, file.name)}</span>
      <span className="min-w-0">
        <span className="block text-sm text-cream-100 truncate">{file.name}</span>
        <span className="block text-[11px] text-ink-500">{fmtBytes(file.size)}</span>
      </span>
    </a>
  );
}

// Cap rendered messages so very long channels stay light (older ones stay in
// state and can still be scrolled once loaded, but we don't paint them all).
const MAX_RENDERED = 200;

// Wrap known @mentions (and @everyone) in a highlighted pill, Discord-style.
const MENTION_RE = /(@everyone|@[A-Za-z0-9_-]+)/g;
function highlightMentions(children: ReactNode, handles: Set<string>): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    const parts = child.split(MENTION_RE);
    return parts.map((part, i) => {
      const isMention = part === '@everyone' || (part.startsWith('@') && handles.has(part.slice(1).toLowerCase()));
      return isMention ? (
        <span key={i} className="bg-clay/20 text-clay rounded px-1 font-medium">{part}</span>
      ) : (
        part
      );
    });
  });
}

export default function MessageFeed() {
  const { messages, activeChannel, loadingMessages, agents } = useServer();
  const mentionHandles = new Set(agents.map((a) => a.name.replace(/\s+/g, '').toLowerCase()));
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!activeChannel) {
    return <div className="flex-1 flex items-center justify-center text-ink-500">Pick a channel to start.</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      {loadingMessages && <div className="text-center text-ink-500 text-sm py-4">Loading…</div>}
      {!loadingMessages && messages.length === 0 && (
        <div className="h-full flex flex-col items-center justify-center text-center text-ink-500">
          <div className="text-4xl mb-3">💬</div>
          <p className="text-cream-300 font-medium">This is the start of #{activeChannel.name}.</p>
          <p className="text-sm mt-1">Say hi, or @mention an agent to put them to work.</p>
        </div>
      )}
      {messages.length > MAX_RENDERED && (
        <div className="text-center text-[11px] text-ink-600 mb-2">Showing the {MAX_RENDERED} most recent messages</div>
      )}
      <div className="flex flex-col gap-1">
        {(messages.length > MAX_RENDERED ? messages.slice(-MAX_RENDERED) : messages).map((m) => {
          const agent = agents.find((a) => a.id === m.agentId);
          return <MessageItem key={m.id} m={m} agentColor={agent?.roleColor} isManager={agent?.isManager} mentionHandles={mentionHandles} />;
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}

function MessageItem({ m, agentColor, isManager, mentionHandles }: { m: Message; agentColor?: string; isManager?: boolean; mentionHandles: Set<string> }) {
  const { activeServer } = useServer();
  const { user } = useAuth();
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  const name = m.senderType === 'AGENT' ? (m.agentName ?? 'Agent') : m.senderType === 'SYSTEM' ? 'System' : (m.userId === user?.id ? (user?.displayName ?? 'You') : 'User');
  const isAgent = m.senderType === 'AGENT';

  const react = async (kind: 'up' | 'down', fb?: string) => {
    if (!activeServer) return;
    try {
      await reactionsApi.add(activeServer.id, m.id, kind, fb);
    } catch { /* ignore */ }
    setShowFeedback(false);
    setFeedback('');
  };

  const card = m.contentType === 'CARD' ? (m.meta as { name?: string; url?: string; planId?: string; questionId?: string; draftId?: string } | undefined) : undefined;
  const planId = card?.planId;
  const questionId = card?.questionId;
  const draftId = card?.draftId;

  return (
    <div className="group flex gap-3 px-2 py-1.5 rounded-lg hover:bg-ink-800/50 transition-colors animate-fade-in">
      <Avatar
        name={name}
        size={36}
        url={isAgent ? undefined : undefined}
        ring={isManager ? 'ring-2 ring-clay' : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm" style={isAgent && agentColor ? { color: agentColor } : { color: '#f3f1ea' }}>{name}</span>
          {isAgent && <span className="text-[10px] uppercase tracking-wide text-ink-500 bg-ink-750 px-1.5 py-0.5 rounded">agent</span>}
          <span className="text-xs text-ink-500">{relTime(m.createdAt)}</span>
        </div>

        <div className="text-cream-100 text-sm mt-0.5 markdown-body">
          {planId ? (
            <PlanCard planId={planId} />
          ) : questionId ? (
            <QuestionCard questionId={questionId} />
          ) : draftId ? (
            <EmailDraftCard draftId={draftId} />
          ) : card ? (
            <a href={card.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 mt-1 px-3 py-2 rounded-lg bg-ink-800 border border-ink-600 hover:border-clay transition-colors">
              📄 <span className="text-clay">{card.name}</span>
            </a>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code(props) {
                  const { children, className } = props as { children?: React.ReactNode; className?: string };
                  const match = /language-(\w+)/.exec(className || '');
                  const text = String(children).replace(/\n$/, '');
                  if (match) {
                    return (
                      <SyntaxHighlighter style={oneDark as never} language={match[1]} PreTag="div" customStyle={{ borderRadius: 8, margin: '6px 0', fontSize: 13 }}>
                        {text}
                      </SyntaxHighlighter>
                    );
                  }
                  return <code className="bg-ink-700 rounded px-1 py-0.5 text-[13px]">{children}</code>;
                },
                a: (p) => <a {...p} className="text-clay hover:underline" target="_blank" rel="noreferrer" />,
                p: ({ children }) => <p>{highlightMentions(children, mentionHandles)}</p>,
                li: ({ children }) => <li>{highlightMentions(children, mentionHandles)}</li>,
              }}
            >
              {m.content}
            </ReactMarkdown>
          )}
        </div>

        {/* Attachments */}
        {m.files && m.files.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {m.files.map((f) => <Attachment key={f.id} file={f} />)}
          </div>
        )}

        {/* Reactions */}
        {isAgent && (
          <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => react('up')} className="text-xs px-1.5 py-0.5 rounded hover:bg-ink-700">👍</button>
            <button onClick={() => setShowFeedback((s) => !s)} className="text-xs px-1.5 py-0.5 rounded hover:bg-ink-700">👎</button>
          </div>
        )}
        {showFeedback && (
          <div className="mt-1 flex gap-2 items-center animate-fade-in">
            <input
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') react('down', feedback); }}
              placeholder="What was wrong? (fed back to the agent)"
              className="flex-1 text-xs bg-ink-800 border border-ink-600 rounded-lg px-2 py-1 focus:outline-none focus:border-clay"
            />
            <button onClick={() => react('down', feedback)} className="text-xs text-clay">Send</button>
          </div>
        )}

        {/* reaction counts */}
        {m.reactions?.length > 0 && (
          <div className="flex gap-1 mt-1">
            {m.reactions.filter((r) => r.kind === 'up').length > 0 && (
              <span className="text-xs bg-ink-700 rounded-full px-1.5">👍 {m.reactions.filter((r) => r.kind === 'up').length}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
