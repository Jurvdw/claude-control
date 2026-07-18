import { useServer } from '../state/ServerContext';
import { Avatar } from './ui';

// Discord-style "…is typing" bar above the composer. Lights up while agents are
// actively thinking/working, and disappears when they go idle.
export default function TypingIndicator() {
  const { agents } = useServer();
  const active = agents.filter((a) => a.status === 'THINKING' || a.status === 'WORKING');
  if (active.length === 0) return <div className="h-5" />; // reserve space to avoid layout jump

  const names = active.map((a) => a.name);
  const label =
    names.length === 1
      ? <><strong className="text-cream-200">{names[0]}</strong> is typing</>
      : names.length === 2
        ? <><strong className="text-cream-200">{names[0]}</strong> and <strong className="text-cream-200">{names[1]}</strong> are typing</>
        : <><strong className="text-cream-200">{active.length}</strong> agents are typing</>;

  return (
    <div className="px-8 h-5 flex items-center gap-2 text-xs text-cream-400 animate-fade-in">
      <div className="flex -space-x-1.5">
        {active.slice(0, 3).map((a) => (
          <Avatar key={a.id} name={a.name} url={a.avatarUrl} size={16} ring="ring-2 ring-ink-850" />
        ))}
      </div>
      <span>{label}</span>
      <span className="inline-flex items-end gap-0.5 ml-0.5">
        <Dot delay={0} />
        <Dot delay={160} />
        <Dot delay={320} />
      </span>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return <span className="w-1 h-1 rounded-full bg-clay animate-pulse-dot" style={{ animationDelay: `${delay}ms` }} />;
}
