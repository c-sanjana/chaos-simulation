export interface FixTab {
  id: string;
  /** Name for the tab, e.g. "Bound the queue" (the tab wraps rather than cutting it off). */
  short: string;
  /** Heading for the panel, e.g. "Bound the queue (load shedding)". */
  name: string;
  /** What changes, one plain sentence, e.g. "DB lets at most 93 requests wait per instance…". */
  what: string;
  /** How the change works: the mechanism, never the outcome. */
  how: string;
  /** Why it was suggested, a sentence, e.g. "Retries made up 74% of DB's load." */
  why: string;
  /**
   * Why it worked, or why it didn't, in this run (measured), e.g. { title: "Why it didn't help
   * here", text: "Users' apps (5×) … still retry, so …" }; absent until the run with the fix is in.
   */
  verdict?: { title: string; text: string };
  /** Measured outcome at the viewer's settings, e.g. "Stuck → recovers in 3 s". */
  result: string;
  /** Where the result was measured, e.g. "at your settings (200 req/s · 3 DB retries)". */
  where: string;
  /** e.g. "242 failed requests instead of 12,687", or "no change: 12,687 failed requests". */
  failed: string;
  /** Robustness checks, e.g. ["Helped on 5 of 5 random runs", "Still helps if the slowdown lasts 10 s"]; empty when not checked. */
  checks: string[];
  /** Short outcome for the tab itself, e.g. "2 s"; empty for a fix that did not help. */
  badge: string;
  /**
   * Did it help, and does it hold up: 'reliable', 'unreliable' (helped only sometimes), 'rare'
   * (helped in at most one random run: luck, so marked like a fix that didn't help), 'checking',
   * or 'no'.
   */
  status: 'reliable' | 'unreliable' | 'rare' | 'checking' | 'no';
  /** Seconds back to normal after the failure ended (0 if never thrown off); null if it never got back. */
  recoverySeconds: number | null;
  /** Requests that failed with the fix. */
  failedCount: number;
  pros: string[];
  /** Drawbacks: measured ones from this run first, then the general ones. */
  cons: string[];
}

export interface FixTabsProps {
  tabs: FixTab[];
  /** The fix shown, in this panel and in the before/after comparison. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const MARK: Record<FixTab['status'], string> = { reliable: '✓', checking: '✓', unreliable: '⚠', rare: '✕', no: '✕' };
const STATUS_TEXT: Record<FixTab['status'], string> = {
  reliable: 'helped',
  checking: 'helped (checking whether it holds up)',
  unreliable: 'helped only sometimes',
  rare: 'helped only by luck',
  no: 'did not help',
};

/** e.g. "Bound the queue: helped, back to normal 2 s after the failure ended". */
export function tabLabel(t: FixTab): string {
  return `${t.short}: ${STATUS_TEXT[t.status]}${t.badge ? `, back to normal ${t.badge} after the failure ended` : ''}`;
}

const helpedStatus = (s: FixTab['status']) => s === 'reliable' || s === 'checking' || s === 'unreliable';

/**
 * Why the first tab is first, from the same keys the ranking uses, in its order (fixes/rank.ts):
 * did it help, did it hold up in the checks, how soon it got back to normal (times within a
 * second are a tie), then failed requests. Compared with the runner-up. Null when nothing helped.
 * ASSUMPTION: the tabs arrive in the ranking's order; this only puts that order into words.
 */
export function rankedFirstReason(tabs: FixTab[]): string | null {
  const [first, second] = tabs;
  if (!first || !helpedStatus(first.status)) return null;
  if (!second || !helpedStatus(second.status)) return first.status === 'unreliable' ? 'It is the only fix that helped at all, though only sometimes.' : 'It is the only fix that held up here.';
  if ((first.status === 'reliable' || first.status === 'checking') && second.status === 'unreliable') return `It held up in the checks; ${second.short} helped only sometimes.`;
  const [a, b] = [first.recoverySeconds ?? Infinity, second.recoverySeconds ?? Infinity];
  if (a + 1 < b) return `It got back to normal soonest: ${a} s after the failure ended, against ${b === Infinity ? 'never' : `${b} s`} for ${second.short}.`;
  if (first.failedCount < second.failedCount) {
    return `It got back to normal about as soon as ${second.short} (${a} s and ${b} s) but failed fewer requests (${count(first.failedCount)} against ${count(second.failedCount)}).`;
  }
  return 'It ranks first by the checks it passed, then how soon it got back to normal, then failed requests.';
}

function count(n: number): string {
  try {
    return n.toLocaleString('en-US');
  } catch {
    return String(n);
  }
}

/**
 * Fixes as tabs (reliable ones first; ones that did not help come last, muted), with a key to the
 * marks and numbers on them. Choosing a tab shows that fix everywhere: its details below and the
 * before/after comparison and maps. The panel says what changes, how it works, why it was
 * suggested, why it worked or didn't here, what happened, and its pros and cons.
 */
export function FixTabs({ tabs, selectedId, onSelect }: FixTabsProps) {
  if (tabs.length === 0) return null;
  const selected = tabs.find((t) => t.id === selectedId) ?? tabs[0];
  const reason = selected.id === tabs[0].id ? rankedFirstReason(tabs) : null;
  return (
    <div className="csl-fixtabs">
      <p className="csl-fixtabs__key" id="fix-tabs-key">
        <span>
          <b className="csl-fixtabs__good">✓</b> held up in the checks
        </span>
        <span>
          <b className="csl-fixtabs__warn">⚠</b> helped only sometimes
        </span>
        <span>
          <b>✕</b> didn't help (or only by luck)
        </span>
        <span>
          <span className="csl-mono">12 s</span> = time to recover after the failure ended
        </span>
      </p>
      <div className="csl-fixtabs__list" role="tablist" aria-label="Fixes" aria-describedby="fix-tabs-key">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`fix-tab-${t.id}`}
            aria-selected={t.id === selected.id}
            aria-controls="fix-tab-panel"
            aria-label={tabLabel(t)}
            title={tabLabel(t)}
            className={`csl-fixtab csl-fixtab--${t.status}`}
            onClick={() => onSelect(t.id)}
          >
            <span className="csl-fixtab__mark" aria-hidden="true">
              {MARK[t.status]}
            </span>
            <span className="csl-fixtab__name">{t.short}</span>
            {t.badge && <span className="csl-fixtab__badge">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="csl-fixtabs__panel" role="tabpanel" id="fix-tab-panel" aria-labelledby={`fix-tab-${selected.id}`}>
        <div className="csl-fixtabs__head">
          <div>
            <h3 className="csl-fixtabs__title">{selected.name}</h3>
            <p className="csl-fixtabs__what">{selected.what}</p>
          </div>
          <span className="csl-chip csl-chip--neutral csl-fixtabs__shown">Shown on the right</span>
        </div>
        <dl className="csl-fixtabs__facts">
          <dt>How it works</dt>
          <dd>{selected.how}</dd>
          <dt>Why try it</dt>
          <dd>{selected.why}</dd>
          <dt>Result</dt>
          <dd>
            <b className={selected.status === 'no' || selected.status === 'rare' ? 'csl-fixtabs__bad' : selected.status === 'unreliable' ? 'csl-fixtabs__warn' : 'csl-fixtabs__good'}>{selected.result}</b>{' '}
            <span className="csl-fixtabs__where">{selected.where}</span>
            <span className="csl-fixtabs__detail">{[selected.failed, ...selected.checks].join(' · ')}</span>
          </dd>
          {selected.verdict && (
            <>
              <dt>{selected.verdict.title}</dt>
              <dd>{selected.verdict.text}</dd>
            </>
          )}
          {reason && (
            <>
              <dt>Why it's ranked first</dt>
              <dd>{reason}</dd>
            </>
          )}
        </dl>
        <div className="csl-fixtabs__procon">
          <ProCon title="Pros" sign="+" items={selected.pros} tone="good" />
          <ProCon title="Cons" sign="−" items={selected.cons} tone="bad" />
        </div>
      </div>
    </div>
  );
}

/** One list with its count in the heading, so several cons are never missed. */
function ProCon({ title, sign, items, tone }: { title: string; sign: string; items: string[]; tone: 'good' | 'bad' }) {
  return (
    <section className={`csl-procon csl-procon--${tone}`} aria-label={title}>
      <h4 className="csl-procon__title">
        {title} <span className="csl-procon__count">({items.length})</span>
      </h4>
      <ul className="csl-procon__list">
        {items.map((item) => (
          <li key={item}>
            <span className="csl-procon__sign" aria-hidden="true">
              {sign}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
