import type { View } from '../pages/AppPage';

export interface TourStep {
  id: string;
  view: View | null; // null = don't change the current view (welcome/closing cards)
  target: string | null; // data-tour selector value; null = centered, non-anchored card
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    view: 'chat',
    target: null,
    title: 'Welcome to Claude Control',
    body: 'This is #general. Your Manager is already here and ready to work.',
  },
  {
    id: 'chat',
    view: 'chat',
    target: 'composer',
    title: 'Talk to your agents',
    body: "Agents only respond when @mentioned — that's how you talk to any of them, including your Manager. Try sending the message below, or hit Next to skip ahead.",
  },
  {
    id: 'brain',
    view: 'brain',
    target: 'nav-brain',
    title: 'The Brain',
    body: 'Shared long-term memory across all your agents: notes plus a privacy vault that keeps sensitive values out of what gets sent to the model.',
  },
  {
    id: 'tasks',
    view: 'tasks',
    target: 'nav-tasks',
    title: 'Tasks',
    body: 'How agents track and hand off work to each other.',
  },
  {
    id: 'workflows',
    view: 'workflows',
    target: 'nav-workflows',
    title: 'Workflows',
    body: 'Automation: a trigger, a sequence of steps, and an agent action at the end. Templates like "Daily digest" and "Research → Brain" are ready to copy.',
  },
  {
    id: 'triggers',
    view: 'triggers',
    target: 'nav-triggers',
    title: 'Triggers',
    body: "Workflows don't have to be run by hand — set them to fire on a schedule or a webhook here.",
  },
  {
    id: 'closing',
    view: null,
    target: null,
    title: "That's the core loop",
    body: 'Settings has your connected account, the privacy vault, and usage — explore anytime.',
  },
];
