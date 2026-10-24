import { FIX_CATALOG } from '../fixes/catalog';
import type { TourStop } from './components/Tour';

/** The fix the tour names on step 3, by its tab name (checked against a fresh run in tourStops.test.ts). */
export const TOUR_FIX = FIX_CATALOG.find((d) => d.kind === 'boundQueue')!.short;

/**
 * The guided tour, told as a demo: the retry storm on the default system (200 requests a second;
 * users' apps ask again up to 5 times, the Gateway 3 and the app server once), followed from calm
 * traffic to stuck, then its tipping point and a fix. The features are introduced where the story
 * needs them.
 *
 * Each `target` matches a `data-tour` attribute in the page. `atMs` moves the step 1 replay to
 * that moment (playing forward to it), so the viewer sees what the stop describes. Stops about
 * results that take a while (the map, the fixes) wait for them (`waitForResults`). Things on screen
 * are named where possible ("the striped arrows"). The numbers in the
 * text are the default run's: `tourStops.test.ts` checks them against a fresh simulation. The last
 * stop (the "?" button) is visible on every screen, so it stays on the previous screen.
 */
export const tourStops: TourStop[] = [
  {
    target: 'scenario',
    screen: 0,
    atMs: 0,
    title: 'Demo: a retry storm',
    body: 'Let’s follow one failure. 200 requests a second; at 30 s the database slows down 8× for just 5 seconds. Watch what happens.',
  },
  {
    target: 'topology',
    screen: 0,
    atMs: 20_000,
    title: 'Normal traffic',
    body: 'Requests flow from users’ apps through the Gateway and app server to the database. All calm.',
  },
  {
    target: 'topology',
    screen: 0,
    // By 34 s users' apps have started asking again too (their first repeats arrive at 33 s).
    atMs: 34_000,
    title: 'The database slows down',
    body: 'Answers take longer than the app server waits (1 s), so it asks again. So do the Gateway and users’ apps: the striped arrows.',
  },
  {
    target: 'charts',
    screen: 0,
    atMs: 34_500,
    title: 'Repeats pile up',
    body: 'The “Retries (repeats)” band piles up and pushes the database past what it can handle: the dashed capacity line.',
  },
  {
    target: 'story',
    screen: 0,
    atMs: 37_000,
    title: 'The failure is over…',
    body: 'At 35 s the database is back to full speed. But the pile of repeats is still there, keeping it overloaded.',
  },
  {
    target: 'story',
    screen: 0,
    atMs: 120_000,
    title: '…but it never recovers',
    body: 'Most of the database’s work is now for requests nobody is waiting for. That self-sustaining loop is a retry storm.',
  },
  {
    target: 'playback',
    screen: 0,
    title: 'Replay it yourself',
    body: 'Play, pause or drag through the run; the diagram, charts and story follow.',
  },
  {
    target: 'map',
    screen: 1,
    waitForResults: true,
    title: 'Where’s the tipping point?',
    body: 'Each cell re-runs the failure with other traffic or a longer slowdown. A bar marks the tipping point, where runs start getting stuck. Click one to replay it.',
  },
  {
    target: 'fix-tabs',
    screen: 2,
    waitForResults: true,
    title: 'Does a fix help?',
    body: `Each tab is one change, re-run on the same traffic: ✓ held up, ⚠ only sometimes, ✕ didn’t help. Here, ${TOUR_FIX} holds up.`,
  },
  {
    target: 'fix-maps',
    screen: 2,
    waitForResults: true,
    title: 'Did the tipping point move?',
    body: 'Before and after, side by side. Click any cell to replay it both ways.',
  },
  {
    target: 'help',
    screen: 2,
    title: 'Your turn',
    body: 'Try Change failure, or build your own system. Use the ? button to see this demo again.',
  },
];
