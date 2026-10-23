/**
 * Test double for uPlot (jsdom has no canvas). Use in a test file with:
 *   vi.mock('uplot', () => import('./testing/fakeUplot'));
 */
export default class FakeUPlot {
  static instances: FakeUPlot[] = [];
  constructor(
    public opts: unknown,
    public data: unknown,
    public target: HTMLElement,
  ) {
    FakeUPlot.instances.push(this);
  }
  setData(d: unknown) {
    this.data = d;
  }
  redraw() {}
  setSize() {}
  destroy() {}
}
