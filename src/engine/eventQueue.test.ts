import { EventQueue } from './eventQueue';
import { uniform } from './rng';

/** Pops everything, running each callback, and returns the log the callbacks wrote. */
function drain<T>(q: EventQueue, log: T[]): T[] {
  for (let f = q.pop(); f; f = q.pop()) f();
  return log;
}

describe('EventQueue', () => {
  it('starts empty', () => {
    const q = new EventQueue();
    expect(q.size).toBe(0);
    expect(q.peekTime()).toBe(Infinity);
    expect(q.pop()).toBeUndefined();
  });

  it('pops in time order', () => {
    const q = new EventQueue();
    const log: number[] = [];
    for (const t of [5, 1, 4, 2, 3, 0, 9, 7]) q.push(t, () => log.push(t));
    expect(q.size).toBe(8);
    expect(q.peekTime()).toBe(0);
    expect(drain(q, log)).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(q.size).toBe(0);
    expect(q.peekTime()).toBe(Infinity);
  });

  it('breaks ties FIFO by insertion order', () => {
    const q = new EventQueue();
    const log: string[] = [];
    q.push(2, () => log.push('2a'));
    q.push(1, () => log.push('1a'));
    q.push(2, () => log.push('2b'));
    q.push(1, () => log.push('1b'));
    q.push(2, () => log.push('2c'));
    q.push(1, () => log.push('1c'));
    expect(drain(q, log)).toEqual(['1a', '1b', '1c', '2a', '2b', '2c']);
  });

  it('keeps FIFO order for many events at one time, interleaved with pops', () => {
    const q = new EventQueue();
    const log: number[] = [];
    for (let i = 0; i < 100; i++) q.push(10, () => log.push(i));
    for (let i = 0; i < 50; i++) q.pop()!();
    for (let i = 100; i < 200; i++) q.push(10, () => log.push(i));
    drain(q, log);
    expect(log).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('peekTime tracks the minimum as events are pushed and popped', () => {
    const q = new EventQueue();
    q.push(3, () => {});
    expect(q.peekTime()).toBe(3);
    q.push(1, () => {});
    expect(q.peekTime()).toBe(1);
    q.pop();
    expect(q.peekTime()).toBe(3);
    q.pop();
    expect(q.peekTime()).toBe(Infinity);
  });

  it('accepts events scheduled by callbacks while draining (as the simulation does)', () => {
    const q = new EventQueue();
    const log: number[] = [];
    let now = 0;
    const tick = (n: number) => () => {
      log.push(now);
      if (n > 0) q.push(now + 1, tick(n - 1));
    };
    q.push(0, tick(4));
    while (q.size > 0) {
      now = q.peekTime();
      q.pop()!();
    }
    expect(log).toEqual([0, 1, 2, 3, 4]);
  });

  it('supports Infinity and negative times', () => {
    const q = new EventQueue();
    const log: number[] = [];
    q.push(Infinity, () => log.push(Infinity));
    q.push(-1, () => log.push(-1));
    q.push(0, () => log.push(0));
    expect(drain(q, log)).toEqual([-1, 0, Infinity]);
  });

  it('rejects NaN times', () => {
    expect(() => new EventQueue().push(NaN, () => {})).toThrow(/NaN/);
  });

  it('matches a stably sorted reference under random pushes and pops', () => {
    const q = new EventQueue();
    // Reference: array of [time, seq], popped by minimum (time, seq).
    const ref: Array<[number, number]> = [];
    const popped: number[] = [];
    const expected: number[] = [];
    let seq = 0;
    for (let step = 0; step < 20_000; step++) {
      const u = uniform(99, 1, step);
      if (u < 0.55 || ref.length === 0) {
        // Coarse times (0..49) so ties are frequent.
        const t = Math.floor(uniform(99, 2, step) * 50);
        const id = seq++;
        q.push(t, () => popped.push(id));
        ref.push([t, id]);
      } else {
        let best = 0;
        for (let i = 1; i < ref.length; i++) {
          if (ref[i][0] < ref[best][0] || (ref[i][0] === ref[best][0] && ref[i][1] < ref[best][1])) best = i;
        }
        expect(q.peekTime()).toBe(ref[best][0]);
        expected.push(ref[best][1]);
        ref.splice(best, 1);
        q.pop()!();
      }
      expect(q.size).toBe(ref.length);
    }
    // Drain the rest.
    ref.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, id] of ref) expected.push(id);
    drain(q, popped);
    expect(popped).toEqual(expected);
  });

  it('sorts a large random batch', () => {
    const q = new EventQueue();
    const times: number[] = [];
    for (let i = 0; i < 50_000; i++) {
      const t = uniform(5, 3, i) * 1000;
      times.push(t);
      q.push(t, () => {});
    }
    times.sort((a, b) => a - b);
    for (const t of times) {
      expect(q.peekTime()).toBe(t);
      q.pop();
    }
    expect(q.size).toBe(0);
  });
});
