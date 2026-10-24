import type { TourStop } from './components/Tour';

/**
 * The guided tour, told as a demo: the retry storm on the default system (200 requests a second,
 * retries 5 / 3 / 1), followed from calm traffic to stuck, then its tipping point and a fix. The
 * features are introduced where the story needs them.
 *
 * Each `target` matches a `data-tour` attribute in the page. `atMs` moves the step 1 replay to
 * that moment (playing forward to it), so the viewer sees what the stop describes. The numbers in
 * the text are the default run's: `tourStops.test.ts` checks them against a fresh simulation.
 * The last stop (the "?" button) is visible on every screen, so it stays on the previous screen.
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
    body: 'Requests flow from users’ apps through the Gateway and API to the database, with a cache beside the API. All calm.',
  },
  {
    target: 'topology',
    screen: 0,
    atMs: 32_000,
    title: 'The database slows down',
    body: 'Answers now take longer than the API waits (1 s), so it gives up and asks again. So do the Gateway and users’ apps: the orange stripes.',
  },
  {
    target: 'charts',
    screen: 0,
    atMs: 34_000,
    title: 'Repeats pile up',
    body: 'Orange is repeated requests. Together they push the database past what it can handle: the dashed line.',
  },
  {
    target: 'story',
    screen: 0,
    atMs: 37_000,
    title: 'The failure is over…',
    body: 'At 35 s the database is back to full speed. But the pile of repeats is still there, and it keeps the database overloaded.',
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
    title: 'Where’s the tipping point?',
    body: 'Each cell is a full re-run with more traffic or a longer slowdown. Orange cells never recovered. Click one to replay it.',
  },
  {
    target: 'fix-tabs',
    screen: 2,
    title: 'Does a fix help?',
    body: 'Each tab is one change, re-run on the same traffic. A ⚠ means it helped only sometimes. Here, Bound queue holds up.',
  },
  {
    target: 'fix-maps',
    screen: 2,
    title: 'Did the tipping point move?',
    body: 'Before and after, side by side. Click any cell to replay it both ways.',
  },
  {
    target: 'help',
    screen: 2,
    title: 'Your turn',
    body: 'Try another failure with Change failure, or build your own system. Press ? to see this demo again.',
  },
];
