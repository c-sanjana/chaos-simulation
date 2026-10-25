import { fireEvent, render, screen } from '@testing-library/react';
import { Glossary, GLOSSARY } from './Glossary';
import { mergeWindows } from './windows';

describe('Glossary', () => {
  it('explains the jargon the page uses, behind a Glossary button', () => {
    const { container } = render(<Glossary />);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(container.querySelector('summary')!.textContent).toBe('Glossary'); // the icon is decoration
    expect(container.querySelector('summary')!.hasAttribute('aria-label')).toBe(false); // its name is its text
    fireEvent.click(screen.getByText('Glossary'));
    expect(screen.getByRole('heading', { name: 'Glossary: words used on this page' })).toBeTruthy();
    for (const term of ['req/s, rps', 'Timeout', 'Retry', 'Queue', 'Workers', 'p99 (slowest 1%)', 'Random run #']) expect(screen.getByText(term)).toBeTruthy();
    for (const { meaning } of GLOSSARY) expect(meaning).toMatch(/\.$/);
  });
});

describe('mergeWindows', () => {
  it('merges overlapping and touching failure windows so they are tinted once', () => {
    expect(mergeWindows([])).toEqual([]);
    expect(mergeWindows([[30, 35]])).toEqual([[30, 35]]);
    expect(mergeWindows([[40, 50], [30, 35], [34, 38], [50, 52]])).toEqual([[30, 38], [40, 52]]);
    expect(mergeWindows([[10, 40], [20, 30]])).toEqual([[10, 40]]);
    const input: Array<[number, number]> = [[5, 6], [1, 2]];
    mergeWindows(input);
    expect(input).toEqual([[5, 6], [1, 2]]); // not changed
  });
});
