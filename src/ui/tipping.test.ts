import { retryStorm } from '../data/scenarios';
import type { TippingPoint } from '../sweep/sweep';
import { cascadeSentence, tippingSentence } from './tipping';

const yAxis = retryStorm.map.y; // failure length (ms)
const tip = (over: Partial<TippingPoint>): TippingPoint => ({ y: 5000, tipsAtX: 100, irregular: false, firstStuckX: 100, overloadedFromX: null, ...over });
const current = { x: 200, y: 5000 };

describe('tippingSentence', () => {
  it('names the tipping point of the row, and says the viewer is past it only when their own cell got stuck', () => {
    expect(tippingSentence({ tip: tip({}), yAxis, current, currentVerdict: 'stuck' })).toBe(
      'With a 5 s failure, the system tips at 100 req/s. Your 200 req/s is past it: everything looks healthy until a failure like this happens.',
    );
    expect(tippingSentence({ tip: tip({ tipsAtX: 240 }), yAxis, current, currentVerdict: 'recovered' })).toBe('With a 5 s failure, the system tips at 240 req/s. Your 200 req/s is below it.');
    // Stuck below a noisy boundary's clean part.
    expect(tippingSentence({ tip: tip({ tipsAtX: 240 }), yAxis, current, currentVerdict: 'stuck' })).toBe('With a 5 s failure, the system tips at 240 req/s. Your 200 req/s gets stuck.');
  });

  it('never calls an overloaded cell "healthy until a failure", and reports overload separately', () => {
    expect(tippingSentence({ tip: tip({ tipsAtX: 120, overloadedFromX: 200 }), yAxis, current, currentVerdict: 'overloaded' })).toBe(
      'With a 5 s failure, the system tips at 120 req/s. From 200 req/s there is too much traffic even without the failure. Your 200 req/s is more than the system can carry even without a failure.',
    );
    expect(tippingSentence({ tip: tip({ tipsAtX: null, firstStuckX: null, overloadedFromX: 180 }), yAxis, current })).toBe(
      'With a 5 s failure, the failure never leaves the system stuck at the traffic shown. From 180 req/s there is too much traffic even without the failure.',
    );
  });

  it('follows the clicked row: the viewer’s own traffic is mentioned only on their row', () => {
    expect(tippingSentence({ tip: tip({ y: 8000, tipsAtX: 80, firstStuckX: 80 }), yAxis, current, currentVerdict: 'stuck' })).toBe('With an 8 s failure, the system tips at 80 req/s.');
    expect(tippingSentence({ tip: tip({ tipsAtX: null, firstStuckX: null }), yAxis, current })).toBe('With a 5 s failure, the system recovers at every traffic level shown.');
  });

  it('gives a range for a noisy row instead of one tipping point', () => {
    expect(tippingSentence({ tip: tip({ irregular: true, firstStuckX: 140, tipsAtX: 180 }), yAxis, current: { x: 60, y: 1000 } })).toBe(
      'With a 5 s failure, the system tips around 140–180 req/s (a noisy boundary: in between, some runs recover and some get stuck).',
    );
    expect(tippingSentence({ tip: tip({ irregular: true, firstStuckX: 140, tipsAtX: null }), yAxis, current: { x: 60, y: 1000 } })).toBe(
      'With a 5 s failure, some traffic levels get stuck and others recover, so there is no clear tipping point (a noisy boundary).',
    );
  });
});

describe('cascadeSentence', () => {
  const labels = { client: 'Client', gateway: 'Load balancer', api: 'App server' };
  const calls = (client: number, gateway: number, api: number) => [
    { caller: 'client', target: 'gateway', retries: client },
    { caller: 'gateway', target: 'api', retries: gateway },
    { caller: 'api', target: 'db', retries: api },
  ];
  it('uses the story’s every/several rule, and names a single retrying caller', () => {
    expect(cascadeSentence(calls(5, 3, 1), labels)).toBe('Every layer asks again when it gives up (Client 5×, Load balancer 3×, App server 1×), so one failed answer can come back as many requests.');
    expect(cascadeSentence(calls(5, 0, 1), labels)).toBe('Several layers ask again when they give up (Client 5×, App server 1×), so one failed answer can come back as many requests.');
    expect(cascadeSentence(calls(0, 0, 3), labels)).toBe('App server asks again when it gives up (3×), so one failed answer can come back as more requests.');
    expect(cascadeSentence(calls(0, 0, 0), labels)).toBe('');
    expect(cascadeSentence([{ caller: 'x', target: 'y', retries: 2 }, { caller: 'z', target: 'w', retries: 1 }], {})).toMatch(/^Every layer asks again when it gives up \(x 2×, z 1×\)/);
  });
});
