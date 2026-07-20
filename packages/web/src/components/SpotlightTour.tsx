import { useEffect, useState, useRef } from 'react';
import { useTour } from '../state/TourContext';
import type { View } from '../pages/AppPage';
import { Button } from './ui';

interface Props {
  view: View;
  onChangeView: (v: View) => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function SpotlightTour({ view, onChangeView }: Props) {
  const { active, step, isLastStep, next, skip } = useTour();
  const [rect, setRect] = useState<Rect | null>(null);
  const raf = useRef<number>();

  // Switch to the step's view if it isn't already active.
  useEffect(() => {
    if (step?.view && step.view !== view) onChangeView(step.view);
  }, [step, view, onChangeView]);

  // Track the target element's position every frame (cheap: one bounding-rect
  // read; setRect only fires — and only re-renders — when it actually moves).
  useEffect(() => {
    if (!active || !step?.target) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height
            ? prev
            : { top: r.top, left: r.left, width: r.width, height: r.height },
        );
      }
      raf.current = requestAnimationFrame(measure);
    };
    raf.current = requestAnimationFrame(measure);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [active, step]);

  if (!active || !step) return null;

  const PADDING = 8;
  const cutout = rect
    ? { top: rect.top - PADDING, left: rect.left - PADDING, width: rect.width + PADDING * 2, height: rect.height + PADDING * 2 }
    : null;

  // Card position: to the right of the cutout if there's room, else below it;
  // centered on screen when there is no target (welcome/closing steps).
  const cardStyle: React.CSSProperties = cutout
    ? cutout.left + cutout.width + 320 < window.innerWidth
      ? { top: cutout.top, left: cutout.left + cutout.width + 16 }
      : { top: cutout.top + cutout.height + 16, left: Math.max(16, cutout.left) }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="Product tour">
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ width: '100vw', height: '100vh' }}>
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {cutout && <rect x={cutout.left} y={cutout.top} width={cutout.width} height={cutout.height} rx={10} fill="black" />}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(10,9,8,0.72)" mask="url(#tour-mask)" />
        {cutout && (
          <rect
            x={cutout.left} y={cutout.top} width={cutout.width} height={cutout.height} rx={10}
            fill="none" stroke="#d97757" strokeWidth={2}
          />
        )}
      </svg>

      <div className="absolute w-80 bg-ink-850 border border-ink-700 rounded-2xl p-5 shadow-2xl animate-fade-in" style={cardStyle}>
        <h3 className="text-cream-50 font-semibold text-base">{step.title}</h3>
        <p className="text-cream-300 text-sm mt-2 leading-relaxed">{step.body}</p>
        <div className="flex items-center justify-between mt-4">
          <button type="button" onClick={skip} className="text-xs text-ink-500 hover:text-cream-300">
            Skip tour
          </button>
          <Button type="button" onClick={next}>{isLastStep ? 'Finish' : 'Next'}</Button>
        </div>
      </div>
    </div>
  );
}
