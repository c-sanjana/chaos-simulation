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
  /** Robustness checks, e.g. ["helped in 5 of 5 random runs", "still helps if the slowdown lasts 10 s"]; empty when not checked. */
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
  /**
   * The line shown when no fix helped, e.g. "None of the fixes tried made this run recover."
   * (FixStep words it from the original run's verdict).
   */
  noneHelped?: string;
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
  return `${t.short}${scope}: ${STATUS_TEXT[t.status]}${t.badge ? `, back to normal ${t.badge} after the failure ended` : ''}; ${count(t.failedCount)} failed requests`;
}

/** Helped, fully or partly: the "Fixes that helped" view. 'rare' (only by luck) and 'no' are the other view. */
export const helpedStatus = (s: FixTab['status']) => s === 'reliable' || s === 'checking' || s === 'unreliable';

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

/** The numbers in a retry fix's "across the stack" sentence, for the compact "48× → 26×" line. */
export interface AcrossNumbers {
  /** e.g. "the database". */
  target: string;
  before: string;
  /** e.g. "users' apps 6 × the load balancer 4 × the app server 2". */
  beforeFactors: string;
  after: string;
  /** e.g. "6 × 4 × 1.1"; null when the sentence gives none (one factor, or unchanged). */
  afterFactors: string | null;
}

/**
 * Reads the multiplication out of fixes/amplification's sentence ("… reaching the database up to
 * 48× (users' apps 6 × …). With this fix: up to 26× (6 × 4 × 1.1)." or "… leaves that at 48×.").
 * Null for any other wording (e.g. a fix that changes a call off the worst path): the panel then
 * shows the sentence itself.
 */
export function acrossNumbers(text: string): AcrossNumbers | null {
  const whole = /reaching (.+?) up to ([\d.]+)× \((.+?)\)\./.exec(text);
  if (!whole) return null;
  const fixed = /With this fix: up to ([\d.]+)×(?: \((.+?)\))?\./.exec(text);
  if (fixed) return { target: whole[1], before: whole[2], beforeFactors: whole[3], after: fixed[1], afterFactors: fixed[2] ?? null };
  const same = /This fix leaves that at ([\d.]+)×\./.exec(text);
  return same ? { target: whole[1], before: whole[2], beforeFactors: whole[3], after: same[1], afterFactors: null } : null;
}

/** "More about this fix" open or closed, kept for the browser session (shared by every fix). */
const MORE_KEY = 'csl-fix-more-open';
function readMore(): boolean {
  try {
    return sessionStorage.getItem(MORE_KEY) === '1';
  } catch {
    return false;
  }
}
function writeMore(open: boolean) {
  try {
    sessionStorage.setItem(MORE_KEY, open ? '1' : '0');
  } catch {
    // Storage blocked: it just isn't remembered.
  }
}

type View = 'helped' | 'not';

/**
 * Fixes as tabs in two views: the ones that helped, fully or partly (shown first, in rank order),
 * and the ones tried that didn't (or only by luck). A switch above the tabs moves between them; it
 * is left out when every fix helped, and the second view opens by itself when none did. Choosing a
 * tab in either view shows that fix everywhere: its panel below, the before/after maps and the
 * replay; switching views never changes the chosen fix.
 *
 * The panel leads with the result and one line on why; retry fixes add the multiplication across
 * the stack. How it works, why it was suggested, why it ranks first, the checks and the pros and
 * cons are under "More about this fix", closed by default and remembered for the session.
 */
export function FixTabs({ tabs, selectedId, onSelect, noneHelped }: FixTabsProps) {
  const helped = tabs.filter((t) => helpedStatus(t.status));
  const notHelped = tabs.filter((t) => !helpedStatus(t.status));
  // The viewer's choice of view; until then the helped view, or the other when nothing helped.
  const [chosenView, setChosenView] = useState<View | null>(null);
  const view: View = notHelped.length === 0 ? 'helped' : (chosenView ?? (helped.length === 0 ? 'not' : 'helped'));
  const shown = view === 'helped' ? helped : notHelped;
  const helpedRoving = useRovingTabs(
    helped.map((t) => t.id),
    selectedId,
  );
  const notRoving = useRovingTabs(
    notHelped.map((t) => t.id),
    selectedId,
  );
  const [more, setMore] = useState(readMore);
  if (tabs.length === 0) return null;
  // Nothing chosen yet (still checking; FixStep chooses one once finished): the first fix of the view on screen.
  const selected = tabs.find((t) => t.id === selectedId) ?? shown[0] ?? tabs[0];
  const reason = selected.id === tabs[0].id ? rankedFirstReason(tabs) : null;
  const toggleMore = () => {
    setMore(!more);
    writeMore(!more);
  };
  const list = (kind: View, items: FixTab[], roving: ReturnType<typeof useRovingTabs>) => (
    <div
      className={`csl-fixtabs__list csl-fixtabs__list--${kind}`}
      role="tablist"
      aria-label={kind === 'helped' ? 'Fixes that helped' : "Fixes that didn't help"}
      aria-describedby={`fix-tabs-key-${kind}`}
      hidden={view !== kind}
      ref={roving.listRef}
      onKeyDown={roving.onKeyDown}
      onBlur={roving.onBlur}
    >
      {items.map((t) => (
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
          tabIndex={t.id === roving.focusId ? 0 : -1}
          onFocus={() => roving.setFocusId(t.id)}
          onClick={() => onSelect(t.id)}
        >
          <span className="csl-fixtab__mark" aria-hidden="true">
            {MARK[t.status]}
          </span>
          <span className="csl-fixtab__name">{t.short}</span>
          <span className="csl-fixtab__badge">{t.badge}</span>
          <span className="csl-fixtab__failed">{count(t.failedCount)} failed</span>
        </button>
      ))}
    </div>
  );
  const tone = selected.status === 'no' || selected.status === 'rare' ? 'csl-fixtabs__bad' : selected.status === 'unreliable' ? 'csl-fixtabs__warn' : 'csl-fixtabs__good';
  // The checks are the result's caveat when it didn't hold up; otherwise they wait under "More".
  const caveat = selected.status === 'unreliable' || selected.status === 'rare';
  const across = selected.acrossStack ? acrossNumbers(selected.acrossStack) : null;
  return (
    <div className="csl-fixtabs">
      <div className="csl-fixtabs__bar">
        {notHelped.length > 0 && (
          <div className="csl-fixtabs__views" role="group" aria-label="Which fixes to list">
            <button type="button" className="csl-fixtabs__view" aria-pressed={view === 'helped'} onClick={() => setChosenView('helped')}>
              Fixes that helped <span className="csl-fixtabs__count">({helped.length})</span>
            </button>
            <button type="button" className="csl-fixtabs__view" aria-pressed={view === 'not'} onClick={() => setChosenView('not')}>
              Tried, didn't help <span className="csl-fixtabs__count">({notHelped.length})</span>
            </button>
          </div>
        )}
        <p className="csl-fixtabs__key" id="fix-tabs-key-helped" hidden={view !== 'helped'}>
          <span>
            <b className="csl-fixtabs__good">✓</b> held up
          </span>
          <span>
            <b className="csl-fixtabs__warn">⚠</b> only sometimes
          </span>
          <span>12 s = time to recover</span>
        </p>
        <p className="csl-fixtabs__key" id="fix-tabs-key-not" hidden={view !== 'not'}>
          <span>
            <b>✕</b> didn't help, or only by luck
          </span>
        </p>
      </div>
      {helped.length === 0 && noneHelped && <p className="csl-fixtabs__none">{noneHelped}</p>}
      {list('helped', helped, helpedRoving)}
      {list('not', notHelped, notRoving)}
      <div className="csl-fixtabs__panel" role="tabpanel" id="fix-tab-panel" aria-labelledby={`fix-tab-${selected.id}`} tabIndex={0}>
        <div className="csl-fixtabs__head">
          <div>
            <h3 className="csl-fixtabs__title">{selected.name}</h3>
            <p className="csl-fixtabs__what">{selected.what}</p>
          </div>
          <div className="csl-fixtabs__chips">
            {selected.scope && <span className={`csl-chip csl-fixtabs__scope csl-fixtabs__scope--${selected.scope}`}>{SCOPE_TEXT[selected.scope]}</span>}
            {selectedId !== null && <span className="csl-chip csl-chip--neutral csl-fixtabs__shown">Shown in the replay</span>}
          </div>
        </div>
        {/* The result first, then one line on why; the rest is under "More about this fix". */}
        <p className="csl-fixtabs__result">
          <b className={tone}>{selected.result}</b> <span className="csl-fixtabs__where">{selected.where}</span>
          <span className="csl-fixtabs__detail">{[selected.failed, ...(caveat ? selected.checks : [])].join(' · ')}</span>
        </p>
        <p className="csl-fixtabs__why">
          {selected.verdict ? (
            <>
              <span className="csl-fixtabs__label">{selected.verdict.title}:</span> {selected.verdict.text}
            </>
          ) : (
            <span className="csl-fixtabs__pending">Working out why…</span>
          )}
        </p>
        {selected.acrossStack && <AcrossStack text={selected.acrossStack} numbers={across} />}
        <button type="button" className="csl-fixtabs__more-btn" aria-expanded={more} aria-controls="fix-tab-more" onClick={toggleMore}>
          <span className="csl-fixtabs__chevron" aria-hidden="true">
            {more ? '▾' : '▸'}
          </span>
          More about this fix
        </button>
        {more && (
          <div className="csl-fixtabs__more" id="fix-tab-more">
            <dl className="csl-fixtabs__facts">
              <dt>How it works</dt>
              <dd>{selected.how}</dd>
              <dt>Why it was suggested</dt>
              <dd>{selected.why}</dd>
              {reason && (
                <>
                  <dt>Why it's ranked first</dt>
                  <dd>{reason}</dd>
                </>
              )}
              {!caveat && selected.checks.length > 0 && (
                <>
                  <dt>Checks</dt>
                  <dd>{selected.checks.join(' · ')}</dd>
                </>
              )}
              {across && (
                <>
                  <dt>Across the stack</dt>
                  <dd>{selected.acrossStack}</dd>
                </>
              )}
            </dl>
            <div className="csl-fixtabs__procon">
              <ProCon title="Pros" sign="+" items={selected.pros} tone="good" />
              <ProCon title="Cons" sign="−" items={selected.cons} tone="bad" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A retry fix's multiplication across the stack as one line: "48× → 26×" with the factors under it
 * (the full sentence is read out instead, and shown under "More about this fix"). A sentence this
 * can't read as numbers is shown as it is.
 */
function AcrossStack({ text, numbers }: { text: string; numbers: AcrossNumbers | null }) {
  return (
    <div className="csl-fixtabs__across">
      <span className="csl-fixtabs__label">Across the stack:</span>
      {numbers ? (
        <>
          <span className="csl-sr-only">{text}</span>
          <span className="csl-fixtabs__across-body" aria-hidden="true">
            <span className="csl-fixtabs__across-line">
              <b className="csl-fixtabs__x">{numbers.before}×</b> → <b className="csl-fixtabs__x">{numbers.after}×</b>{' '}
              <span className="csl-fixtabs__across-what">
                {numbers.after === numbers.before ? 'unchanged: ' : ''}calls reaching {numbers.target} if every call fails
              </span>
            </span>
            <span className="csl-fixtabs__factors">
              {numbers.beforeFactors} → {numbers.afterFactors ?? `${numbers.after}`}
            </span>
          </span>
        </>
      ) : (
        <span> {text}</span>
      )}
    </div>
  );
}

/**
 * WAI-ARIA tabs keyboard pattern with manual activation: the tab list is one tab stop; ←/→ or ↑/↓
 * (and Home/End) move focus between tabs, Enter or Space chooses one. Choosing re-simulates the
 * before/after comparison, so merely passing over a tab doesn't.
 */
export function useRovingTabs(ids: string[], selectedId: string | null) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = focusId !== null && ids.includes(focusId) ? focusId : selectedId !== null && ids.includes(selectedId) ? selectedId : (ids[0] ?? null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = current === null ? 0 : ids.indexOf(current);
    // The lists run down the panel (in two columns for the fixes that didn't help), so ↓/↑ work as →/←.
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    const next = forward ? (i + 1) % ids.length : back ? (i - 1 + ids.length) % ids.length : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : null;
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
