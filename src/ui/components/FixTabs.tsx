import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

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
  /** Retry fixes: changed by one caller ('layer') or by every layer that retries ('stack'). */
  scope?: 'layer' | 'stack';
  /** Retry fixes: the end-to-end retry multiplication before and with the fix, e.g. "… up to 48× … With this fix: up to 26× (6 × 4 × 1.1)." */
  acrossStack?: string;
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

const SCOPE_TEXT: Record<NonNullable<FixTab['scope']>, string> = { layer: 'One layer', stack: 'Whole stack' };

const MARK: Record<FixTab['status'], string> = { reliable: '✓', checking: '✓', unreliable: '⚠', rare: '✕', no: '✕' };
const STATUS_TEXT: Record<FixTab['status'], string> = {
  reliable: 'helped',
  checking: 'helped (checking whether it holds up)',
  unreliable: 'helped only sometimes',
  rare: 'helped only by luck',
  no: 'did not help',
};

/** e.g. "Bound the queue: helped, back to normal 2 s after the failure ended", or "Cap retries at 1 (one layer): did not help". */
export function tabLabel(t: FixTab): string {
  // The scope, unless the name already says it ("Budget, one layer"; but "Retry at one layer" changes the whole stack).
  const said = t.scope === 'layer' ? /one layer/i : /all layers/i;
  const scope = t.scope && !said.test(t.short) ? ` (${SCOPE_TEXT[t.scope].toLowerCase()})` : '';
  return `${t.short}${scope}: ${STATUS_TEXT[t.status]}${t.badge ? `, back to normal ${t.badge} after the failure ended` : ''}`;
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
  const roving = useRovingTabs(tabs.map((t) => t.id), selectedId);
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
          <b className="csl-fixtabs__warn">⚠</b> only sometimes
        </span>
        <span>
          <b>✕</b> didn't help (or only by luck)
        </span>
        <span>12 s = time to recover after the failure ended</span>
      </p>
      <div
        className="csl-fixtabs__list"
        role="tablist"
        aria-label="Fixes"
        aria-describedby="fix-tabs-key"
        ref={roving.listRef}
        onKeyDown={roving.onKeyDown}
        onBlur={roving.onBlur}
      >
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
            tabIndex={t.id === (roving.focusId ?? selected.id) ? 0 : -1}
            onFocus={() => roving.setFocusId(t.id)}
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
      <div className="csl-fixtabs__panel" role="tabpanel" id="fix-tab-panel" aria-labelledby={`fix-tab-${selected.id}`} tabIndex={0}>
        <div className="csl-fixtabs__head">
          <div>
            <h3 className="csl-fixtabs__title">{selected.name}</h3>
            <p className="csl-fixtabs__what">{selected.what}</p>
          </div>
          <div className="csl-fixtabs__chips">
            {selected.scope && <span className={`csl-chip csl-fixtabs__scope csl-fixtabs__scope--${selected.scope}`}>{SCOPE_TEXT[selected.scope]}</span>}
            <span className="csl-chip csl-chip--neutral csl-fixtabs__shown">Shown in the replay</span>
          </div>
        </div>
        {/* What happened first (result, then why), then how the fix works in general. */}
        <dl className="csl-fixtabs__facts">
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
          {selected.acrossStack && (
            <>
              <dt>Across the stack</dt>
              <dd>{selected.acrossStack}</dd>
            </>
          )}
          {reason && (
            <>
              <dt>Why it's ranked first</dt>
              <dd>{reason}</dd>
            </>
          )}
          <dt>How it works</dt>
          <dd>{selected.how}</dd>
          <dt>Why try it</dt>
          <dd>{selected.why}</dd>
        </dl>
        <div className="csl-fixtabs__procon">
          <ProCon title="Pros" sign="+" items={selected.pros} tone="good" />
          <ProCon title="Cons" sign="−" items={selected.cons} tone="bad" />
        </div>
      </div>
    </div>
  );
}

/**
 * WAI-ARIA tabs keyboard pattern with manual activation: the tab list is one tab stop; ←/→ (and
 * Home/End) move focus between tabs, Enter or Space chooses one. Choosing re-simulates the
 * before/after comparison, so merely passing over a tab doesn't.
 */
export function useRovingTabs(ids: string[], selectedId: string | null) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = focusId !== null && ids.includes(focusId) ? focusId : selectedId !== null && ids.includes(selectedId) ? selectedId : (ids[0] ?? null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = current === null ? 0 : ids.indexOf(current);
    const next = e.key === 'ArrowRight' ? (i + 1) % ids.length : e.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : null;
    if (next === null || ids.length === 0) return;
    e.preventDefault();
    setFocusId(ids[next]);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  // Leaving the list: the tab stop goes back to the chosen tab.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusId(null);
  };
  return { focusId: current, setFocusId, listRef, onKeyDown, onBlur };
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
