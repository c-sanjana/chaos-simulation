import type { TourStop } from './components/Tour';

/**
 * The guided tour: the essentials of the three steps in about 30 seconds of reading.
 * Each `target` matches a `data-tour` attribute in the page. The last stop (the "?" button) is
 * visible on every screen, so it stays on the previous stop's screen rather than switching tabs.
 */
export const tourStops: TourStop[] = [
  {
    target: 'scenario',
    screen: 0,
    title: 'The failure',
    body: 'What’s being simulated, like a database slowing down for 5 seconds. Change failure picks another.',
  },
  {
    target: 'steps',
    screen: 0,
    title: 'Three steps',
    body: 'What happened, where the tipping point is, and whether a fix helps.',
  },
  {
    target: 'topology',
    screen: 0,
    title: 'Request flow',
    body: 'Arrows show requests per second. Click a box to edit that tier.',
  },
  {
    target: 'playback',
    screen: 0,
    title: 'Replay the run',
    body: 'Play or scrub; the diagram and the metric charts update as it plays.',
  },
  {
    target: 'story',
    screen: 0,
    title: 'What’s happening',
    body: 'The story in plain words, revealed as the replay reaches each step.',
  },
  {
    target: 'map',
    screen: 1,
    title: 'Where’s the tipping point?',
    body: 'Each cell is a full re-run at another traffic level and setting. Click one to replay it.',
  },
  {
    target: 'fix-tabs',
    screen: 2,
    title: 'Try a fix',
    body: 'Each tab is one setting change, re-run on the same traffic and ranked by the result.',
  },
  {
    target: 'fix-maps',
    screen: 2,
    title: 'Did the tipping point move?',
    body: 'Click a cell to replay it before and after.',
  },
  {
    target: 'help',
    screen: 2,
    title: 'Replay this tour',
    body: 'Press ? to see this tour again.',
  },
];
