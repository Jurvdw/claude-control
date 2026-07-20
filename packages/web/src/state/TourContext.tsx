import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { useServer } from './ServerContext';
import { TOUR_STEPS, type TourStep } from '../lib/tourSteps';

interface TourContextValue {
  active: boolean;
  step: TourStep | null;
  isLastStep: boolean;
  prefillText: string | null;
  next: () => void;
  skip: () => void;
  advanceOnSend: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: React.ReactNode }) {
  const { user, completeOnboarding } = useAuth();
  const { activeServer } = useServer();
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  // Guards against re-triggering after finish(): completeOnboarding() is async,
  // so user.onboardedAt can still read stale-null for a moment after the tour
  // ends. Without this, the trigger effect below would immediately restart it.
  const [started, setStarted] = useState(false);

  // One-time trigger: as soon as a workspace exists for a user who has never
  // completed (or skipped) the tour, start it. State-driven rather than
  // route-driven so it fires whether the workspace came from the automated
  // connect-Claude flow or from "Skip for now" + manual creation later.
  useEffect(() => {
    if (started) return;
    if (!user || user.onboardedAt) return;
    if (!activeServer) return;
    setActive(true);
    setStepIndex(0);
    setStarted(true);
  }, [user, activeServer, started]);

  const finish = useCallback(() => {
    setActive(false);
    completeOnboarding().catch(() => {}); // best-effort; harmless to retry on next launch
  }, [completeOnboarding]);

  const next = useCallback(() => {
    setStepIndex((i) => {
      if (i + 1 >= TOUR_STEPS.length) {
        finish();
        return i;
      }
      return i + 1;
    });
  }, [finish]);

  const skip = useCallback(() => finish(), [finish]);

  const advanceOnSend = useCallback(() => {
    if (active && TOUR_STEPS[stepIndex]?.id === 'chat') next();
  }, [active, stepIndex, next]);

  const step = active ? TOUR_STEPS[stepIndex] : null;
  const isLastStep = stepIndex === TOUR_STEPS.length - 1;
  const prefillText = step?.id === 'chat' ? '@Manager ' : null;

  return (
    <TourContext.Provider value={{ active, step, isLastStep, prefillText, next, skip, advanceOnSend }}>
      {children}
    </TourContext.Provider>
  );
}

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within TourProvider');
  return ctx;
}
