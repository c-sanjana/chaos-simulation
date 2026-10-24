import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { chainGraph } from '../builder/testGraphs';
import type { Draft } from './draft';
import { SettingsForm } from './SettingsForm';
import { customSystem, systemDraft } from './system';

let latest: Draft;
function Harness({ initial }: { initial: Draft }) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return <SettingsForm draft={draft} onChange={setDraft} />;
}

describe('SettingsForm on a built system with a queue', () => {
  it("shows a queue's own settings in the builder's words, not machine sizes", () => {
    render(<Harness initial={systemDraft(customSystem(chainGraph(['client', 'queue', 'server'])), '')} />);
    const queue = screen.getByRole('group', { name: 'queue 1' });
    expect(within(queue).queryByLabelText(/^Copies/)).toBeNull();
    expect(within(queue).queryByLabelText('Limit the waiting line')).toBeNull();
    fireEvent.change(within(queue).getByLabelText(/^Messages it can hold/), { target: { value: '500' } });
    fireEvent.change(within(queue).getByLabelText(/^Messages handled at once/), { target: { value: '4' } });
    expect(within(queue).getByLabelText(/^Typical time per message/)).toBeTruthy();
    expect(latest.topology.tiers.find((t) => t.id === 'n1')!.queue).toEqual({ maxDepth: 500, consumers: 4 });
    // The consumers' call to the server, with its timeout switched off and on again.
    const timeout = within(queue).getByLabelText('Give up on server 2 after a timeout');
    fireEvent.click(timeout);
    expect(latest.topology.tiers.find((t) => t.id === 'n1')!.downstream!.timeoutMs).toBeNull();
    fireEvent.click(timeout);
    expect(latest.topology.tiers.find((t) => t.id === 'n1')!.downstream!.timeoutMs).toBe(1000);
  });
});
