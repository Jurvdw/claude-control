import { useEffect, useRef } from 'react';
import { useServer } from '../state/ServerContext';
import { speak, stopSpeaking } from '../lib/voice';

// Reads new agent replies aloud while voice output is enabled. Detects a genuine
// new arrival (length grew by one) so it doesn't narrate history or channel loads.
export default function VoiceManager({ enabled }: { enabled: boolean }) {
  const { messages } = useServer();
  const prevLen = useRef(messages.length);

  useEffect(() => {
    const n = messages.length;
    const grew = n === prevLen.current + 1;
    prevLen.current = n;
    if (!enabled || !grew) return;
    const last = messages[n - 1];
    if (last && last.senderType === 'AGENT' && last.content) speak(last.content);
  }, [messages, enabled]);

  useEffect(() => { if (!enabled) stopSpeaking(); }, [enabled]);

  return null;
}
