// Voice helpers built on the browser's Web Speech API (works in the Electron
// renderer). TTS (speechSynthesis) is reliable everywhere; STT
// (SpeechRecognition) is best-effort — availability is feature-detected.

export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const clean = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[#*`_>~[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  if (!clean) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

interface Recognition {
  start(): void;
  stop(): void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
}

function RecognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechInputAvailable(): boolean {
  return typeof window !== 'undefined' && RecognitionCtor() !== null;
}

export function createRecognition(): Recognition | null {
  const Ctor = RecognitionCtor();
  if (!Ctor) return null;
  const r = new Ctor();
  r.continuous = false;
  r.interimResults = false;
  r.lang = navigator.language || 'en-US';
  return r;
}
