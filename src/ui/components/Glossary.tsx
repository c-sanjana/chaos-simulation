/** The words the page uses that a newcomer may not know, each in one plain sentence (REVIEW2 3.7). */
export const GLOSSARY: Array<{ term: string; meaning: string }> = [
  { term: 'req/s, rps', meaning: 'Requests per second: how many requests arrive (or are handled) each second.' },
  { term: 'Timeout', meaning: 'How long a caller waits for an answer before giving up on it.' },
  { term: 'Retry', meaning: 'Asking again after giving up or getting an error. Each layer can retry, so repeats multiply.' },
  { term: 'Capacity', meaning: 'The most requests a part can finish per second. More than that and work piles up.' },
  { term: 'Queue', meaning: 'Requests waiting for a free worker. A message queue instead stores work to be done later.' },
  { term: 'Workers', meaning: 'The slots a server handles requests in, one at a time. Waiting for another part still holds one.' },
  { term: 'p99 (slowest 1%)', meaning: '99 of every 100 requests were at least this fast; the slowest 1% took longer.' },
  { term: 'Stuck', meaning: 'The failure is over, but the system never got back to normal by the end of the run.' },
  { term: 'Tipping point', meaning: 'The lowest traffic at which the same failure leaves the system stuck.' },
  { term: 'Random run #', meaning: 'Which random traffic the run used. The same number always gives the same traffic, so runs compare fairly.' },
];

/**
 * A "Words" button in the top bar that opens the glossary. A native disclosure, so it works with
 * the keyboard and screen readers without extra code.
 */
export function Glossary() {
  return (
    <details className="csl-glossary">
      <summary className="csl-btn csl-btn--small" aria-label="Words used on this page">
        Words
      </summary>
      <div className="csl-glossary__panel">
        <h2 className="csl-glossary__title">Words used on this page</h2>
        <dl className="csl-glossary__list">
          {GLOSSARY.map(({ term, meaning }) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
