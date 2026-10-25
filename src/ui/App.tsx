import { useEffect, useMemo, useRef, useState } from 'react';
import { buildStory } from '../analysis/story';
import { buildRunConfig } from '../data/buildConfig';
import { graphFromPreset, syncGraph } from '../builder/fromPreset';
import type { BuilderGraph } from '../builder/graph';
import { validateGraph } from '../builder/validate';
import { CachingPool } from '../worker/cachingPool';
import { createDefaultPool, type SimPool } from '../worker/pool';
import { compareRuns, type RunSnapshot } from './compare';
import { Drawer } from './components/Drawer';
import { Glossary } from './components/Glossary';
import { PlayerPlaceholder } from './components/PlayerPlaceholder';
import { RunComparison } from './components/RunComparison';
import { ScenarioPicker } from './components/ScenarioPicker';
import { StepPanel } from './components/StepPanel';
import { StepTabs } from './components/StepTabs';
import { Tour, TourButton } from './components/Tour';
import { BuilderScreen } from './builder/BuilderScreen';
import { draftProblems, type Draft } from './draft';
import { AnnouncerProvider, useAnnounce } from './components/Announcer';
import { FailureEditor, ScenarioSummary } from './FailureEditor';
import { FixStep } from './FixStep';
import { RunPlayer } from './RunPlayer';
import { SettingsForm } from './SettingsForm';
import { focusField, useInvalidFields } from './components/useInvalidFields';
import { loadSaved, saveState } from './savedSystem';
import { carryOver, customSystem, editedDraft, PRESET_SYSTEM, scenarioCatalog, systemDraft, withTrafficAxis, type System } from './system';
import { ThemeToggle } from './themeMode';
import { TippingStep } from './TippingStep';
import { tourStops } from './tourStops';
import { usePendingFocus } from './usePendingFocus';
import { useTour } from './useTour';
import { useCancellableAnalysis, type Async } from './useSimulation';
import { useMediaQuery } from './useMediaQuery';
import { labelsOf } from './viewModels';

const DEFAULT_SCENARIO = 'retry-storm';

/** Where focus goes after big actions (see usePendingFocus). */
const FOCUS = {
  /** The current step's main heading (or the error in its place). */
  stepHeading: '#csl-step-heading',
  buildButton: '#csl-build-button',
  builderHeading: '#csl-builder h2',
  help: '[data-tour="help"]',
};

/** Below this width the replay's story moves above its chart (the side column is below the fold or gone). */
const STORY_ABOVE_QUERY = '(max-width: 1200px)';

export interface AppProps {
  /** Injected in tests; the app creates a Web Worker pool by default. */
  pool?: SimPool;
}

/**
 * The page: pick a failure, then three steps (what happened → tipping point → does a fix help).
 * `applied` is what is simulated; `draft` holds edits until the viewer runs them.
 */
export function App({ pool: injected }: AppProps) {
  // Every step shares one cache of finished results (see CachingPool).
  const pool = useMemo(() => new CachingPool(injected ?? createDefaultPool()), [injected]);
  useEffect(() => () => {
    if (!injected) pool.dispose();
  }, [pool, injected]);

  /** A built system and its drawing, as remembered in this browser (savedSystem.ts). */
  const [restored] = useState(() => loadSaved());
  /** The example system, or one built on the canvas; `canvas` holds the drawing while the builder is open. */
  const [system, setSystem] = useState<System>(restored?.system ?? PRESET_SYSTEM);
  const [canvas, setCanvas] = useState<BuilderGraph | null>(restored?.canvasOpen ? restored.canvas : null);
  /** A drawing set aside by Cancel or "Use the example system instead"; the builder reopens it. */
  const [keptCanvas, setKeptCanvas] = useState<BuilderGraph | null>(restored && !restored.canvasOpen ? restored.canvas : null);
  /** The drawing on the canvas now, for the notice's action (it runs after later edits). */
  const canvasNow = useRef(canvas);
  canvasNow.current = canvas;
  const [scenarioId, setScenarioId] = useState(restored?.scenarioId ?? DEFAULT_SCENARIO);
  const [applied, setApplied] = useState<Draft>(() => restored?.applied ?? systemDraft(PRESET_SYSTEM, DEFAULT_SCENARIO));
  /** A line under the top bar about what just changed (e.g. a reset failure), with an Undo when it can be undone. */
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(restored?.notice ? { text: restored.notice } : null);
  const [draft, setDraft] = useState<Draft>(applied);
  const [step, setStep] = useState(0);
  /** On steps 2 and 3 the scenario card collapses to one line to leave room for side-by-side views. */
  const [editingFailure, setEditingFailure] = useState(false);
  /** Settings drawer: closed, one tier ('client' = traffic), or every setting (null). */
  const [timelineEl, setTimelineEl] = useState<HTMLElement | null>(null);
  const [settings, setSettings] = useState<{ open: boolean; only: string | null }>({ open: false, only: null });
  const openSettings = (only: string | null) => setSettings({ open: true, only });
  const closeSettings = () => setSettings((s) => ({ ...s, open: false }));

  const labels = useMemo(() => labelsOf(applied.topology), [applied.topology]);
  const config = useMemo(() => buildRunConfig(applied.topology, applied.scenario), [applied]);
  const { state: main, cancel: stopMain, retry: retryMain } = useCancellableAnalysis(pool, config, labels);
  // Steps the viewer has visited stay mounted (hidden) while the settings they show are current.
  const [kept, setKept] = useState<{ applied: Draft; steps: number[] }>({ applied, steps: [] });
  const keptSteps = kept.applied === applied ? kept.steps : [];
  useEffect(() => {
    if (!keptSteps.includes(step)) setKept({ applied, steps: [...keptSteps, step] });
  }, [step, applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const story = useMemo(() => (main.status === 'done' ? buildStory(main.value.run, config, main.value.analysis, labels) : undefined), [main, config, labels]);

  // "Compared with your last run": after a re-run of the same preset with changed settings, the
  // previous finished run is kept for comparison (switching presets starts afresh).
  const lastRun = useRef<RunSnapshot | null>(null);
  const [previousRun, setPreviousRun] = useState<RunSnapshot | null>(null);
  useEffect(() => {
    if (main.status !== 'done') return;
    const last = lastRun.current;
    if (last && last.result !== main.value) setPreviousRun(last.draft.scenario.id === applied.scenario.id ? last : null);
    lastRun.current = { draft: applied, config, result: main.value };
  }, [main]); // eslint-disable-line react-hooks/exhaustive-deps
  const comparison = useMemo(
    () => (previousRun && main.status === 'done' ? compareRuns(previousRun, { draft: applied, config, result: main.value }, labels) : null),
    [previousRun, main, applied, config, labels],
  );
  // First visit: the walkthrough opens once the first run is ready (so its targets exist).
  const tour = useTour();
  const focusAfter = usePendingFocus(main.status !== 'running');
  const storyAbove = useMediaQuery(STORY_ABOVE_QUERY);
  /** The step the tour was started from, to return to when it closes. */
  const [tourFrom, setTourFrom] = useState(0);
  /** The replay moment the demo is showing (null between demo stops and outside the tour). */
  const [demoAtMs, setDemoAtMs] = useState<number | null>(null);
  /**
   * The tour is a demo of the default retry storm. Started from "?" with other settings (another
   * failure, edits, a built system, the canvas open), it switches to the default for the demo and
   * puts everything back when it closes.
   */
  const beforeDemo = useRef<{ system: System; scenarioId: string; applied: Draft; draft: Draft; canvas: BuilderGraph | null; editing: boolean } | null>(null);
  // Remember the built system, what runs on it and the drawing; never the tour's demo in their place.
  useEffect(() => {
    if (!beforeDemo.current) saveState({ system, scenarioId, applied, canvas: canvas ?? keptCanvas, canvasOpen: canvas !== null });
  }, [system, scenarioId, applied, canvas, keptCanvas]);
  const startTour = () => {
    setTourFrom(step);
    const demo = systemDraft(PRESET_SYSTEM, DEFAULT_SCENARIO);
    if (system.kind !== 'preset' || canvas !== null || JSON.stringify(applied) !== JSON.stringify(demo) || JSON.stringify(draft) !== JSON.stringify(demo)) {
      beforeDemo.current = { system, scenarioId, applied, draft, canvas, editing: editingFailure };
      setSystem(PRESET_SYSTEM);
      setScenarioId(DEFAULT_SCENARIO);
      setApplied(demo);
      setDraft(demo);
      setCanvas(null);
      setEditingFailure(false);
    }
    lastRun.current = null; // the demo run isn't a re-run to compare with
    setPreviousRun(null);
    tour.start();
  };
  /**
   * After the demo is finished (Done), the step 1 replay waits at its end with the verdict the tour
   * led up to, instead of starting over (REVIEW2 3.9). Cleared by the next run.
   */
  const [replayOpenAtMs, setReplayOpenAtMs] = useState<number | null>(null);
  useEffect(() => setReplayOpenAtMs(null), [config]);
  const endTour = (completed: boolean) => {
    tour.close(completed);
    focusAfter(FOCUS.help);
    setStep(tourFrom);
    setDemoAtMs(null);
    setReplayOpenAtMs(completed && !beforeDemo.current ? config.durationMs : null);
    const back = beforeDemo.current;
    beforeDemo.current = null;
    if (back) {
      setSystem(back.system);
      setScenarioId(back.scenarioId);
      setApplied(back.applied);
      setDraft(back.draft);
      setCanvas(back.canvas);
      setEditingFailure(back.editing); // an open, unsaved failure editor comes back as it was
      lastRun.current = null;
      setPreviousRun(null);
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  /** The settings simulated differ from the chosen preset's: its name is shown with "(edited)". */
  const edited = useMemo(() => JSON.stringify(applied) !== JSON.stringify(systemDraft(system, scenarioId)), [applied, system, scenarioId]);
  const problems = draftProblems(draft);

  const pickScenario = (id: string) => {
    if (id === scenarioId && !dirty) return; // already showing this preset; don't wipe the viewer's settings
    // A built system keeps its settings edits (drawer, traffic) when the failure changes.
    const fresh = system.kind === 'custom' ? editedDraft(system, id, draft) : systemDraft(system, id);
    setScenarioId(id);
    setApplied(fresh);
    setDraft(fresh);
  };
  /** Bumped to replay the same run from the start ("Replay from the start" with nothing changed). */
  const [restartKey, setRestartKey] = useState(0);
  const run = () => {
    if (main.status === 'cancelled') retryMain(); // also when these are the stopped settings again
    if (!dirty) {
      setRestartKey((k) => k + 1);
      setStep(0);
    }
    setReplayOpenAtMs(null);
    // On a built system the map's traffic range follows the traffic, so it stays on the map.
    const next = withTrafficAxis(structuredClone(draft));
    setApplied(next);
    setDraft(next);
    setEditingFailure(false);
    setNotice(null);
    focusAfter(FOCUS.stepHeading, true); // the step's heading, once the new run is ready
  };
  const resetToPreset = () => {
    if (main.status === 'cancelled') retryMain();
    const fresh = systemDraft(system, scenarioId);
    setApplied(fresh);
    setDraft(fresh);
  };
  /** Switches to another system: its first scenario, step 1, nothing to compare with. */
  const switchSystem = (next: System) => {
    const fresh = systemDraft(next, '');
    setSystem(next);
    setScenarioId(fresh.scenario.id);
    setApplied(fresh);
    setDraft(fresh);
    setStep(0);
    setEditingFailure(false);
    lastRun.current = null;
    setPreviousRun(null);
    setNotice(null);
  };
  /** The system being simulated as a drawing, with any settings changed since it was drawn. */
  const runningGraph = () => (system.kind === 'custom' ? syncGraph(system.graph, applied.topology, applied.scenario.rps) : graphFromPreset(applied.topology, applied.scenario.rps));
  // The canvas opens on a drawing set aside earlier (saying so, with a way to the running system
  // instead), else on the system being simulated.
  const openBuilder = () => {
    setCanvas(keptCanvas ?? runningGraph());
    setKeptCanvas(null);
    setNotice(
      keptCanvas
        ? {
            text: `This is the drawing you kept from last time, not the ${system.kind === 'custom' ? 'system you are running' : 'example system you are running'}.`,
            action: {
              label: 'Open the system you are running instead',
              run: () => {
                // The kept drawing stays kept for next time.
                setKeptCanvas(canvasNow.current);
                setCanvas(runningGraph());
                setNotice(null);
              },
            },
          }
        : null,
    );
    focusAfter(FOCUS.builderHeading);
  };
  /**
   * Cancel: back to the system as it was. A drawing that differs from the running system is kept
   * for next time, however often the builder is opened and cancelled (code review 3: comparing with
   * the drawing it opened on lost a kept drawing on the second Cancel). The running system itself,
   * unchanged, replaces nothing (a drawing kept while it was open stays kept).
   */
  const cancelBuilder = () => {
    if (JSON.stringify(canvas) !== JSON.stringify(runningGraph())) setKeptCanvas(canvas);
    setCanvas(null);
    setNotice(null);
    focusAfter(FOCUS.buildButton);
  };
  /** "Use this topology": the new system keeps the current failure and step where it can (system.ts carryOver). */
  const useCanvas = (graph: BuilderGraph) => {
    const next = customSystem(graph) as Extract<System, { kind: 'custom' }>;
    const kept = carryOver(applied, scenarioId, next);
    setSystem(next);
    setScenarioId(kept.scenarioId);
    setApplied(kept.draft);
    setDraft(kept.draft);
    setEditingFailure(false);
    lastRun.current = null;
    setPreviousRun(null);
    setCanvas(null);
    setKeptCanvas(null);
    setNotice(kept.reset ? { text: kept.reset } : null);
    focusAfter(FOCUS.buildButton);
  };
  /** "Use the example system instead", with an Undo; the drawing is kept for the builder. */
  const useExample = () => {
    const back = { system, scenarioId, applied, draft, step };
    switchSystem(PRESET_SYSTEM);
    setKeptCanvas(canvas);
    setCanvas(null);
    focusAfter(FOCUS.buildButton);
    setNotice({
      text: 'Switched to the example system. Your drawing is kept: ✎ Build your own system opens it again.',
      action: {
        label: 'Undo',
        run: () => {
          setSystem(back.system);
          setScenarioId(back.scenarioId);
          setApplied(back.applied);
          setDraft(back.draft);
          setStep(back.step);
          setKeptCanvas(null);
          setNotice(null);
        },
      },
    });
  };
  // The drawer's Re-run: blocked while a field shows invalid text or the settings don't fit together.
  const [settingsForm, setSettingsForm] = useState<HTMLFormElement | null>(null);
  const invalidFields = useInvalidFields(settingsForm);
  const problemList = useRef<HTMLUListElement>(null);
  const rerunBlocked = problems.length > 0 || invalidFields.length > 0;
  const showWhyBlocked = () => {
    if (invalidFields.length > 0) return focusField(invalidFields[0]);
    problemList.current?.scrollIntoView?.({ block: 'nearest' });
  };
  const built = system.kind === 'custom';

  return (
    <AnnouncerProvider>
    <AnnounceRun status={main.status} />
    <div className="csl-page">
      <header className="csl-topbar">
        <h1 className="csl-topbar__title" title="See where a system stops recovering on its own, and whether a fix moves that point.">
          Chaos Simulation Lab
        </h1>
        <div data-tour="scenario" className="csl-topbar__summary">
          {/* Hidden while the builder is open: its failures belong to the system being edited. */}
          {canvas === null && <ScenarioSummary draft={applied} editing={editingFailure} edited={edited} onToggle={() => setEditingFailure((e) => !e)} />}
        </div>
        <div className="csl-topbar__actions">
          {canvas === null && (
            <button type="button" id="csl-build-button" className="csl-btn csl-btn--small" onClick={openBuilder}>
              {system.kind === 'custom' ? '✎ Edit your system' : '✎ Build your own system'}
            </button>
          )}
          <Glossary />
          <ThemeToggle />
          <TourButton onClick={startTour} />
        </div>
      </header>
      <main className="csl-main">
      <Tour
        stops={tourStops}
        open={tour.open && main.status === 'done'}
        onClose={endTour}
        onScreen={setStep}
        onStop={(stop) => setDemoAtMs(stop.atMs ?? null)}
      />

      {notice && (
        <p className="csl-notice" role="status">
          {notice.text}
          {notice.action && (
            <button type="button" className="csl-btn csl-btn--link" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
          <button type="button" className="csl-btn csl-btn--link" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {canvas !== null && (
        <section id="csl-builder" className="csl-card csl-card--compact csl-builder-page" aria-label="Build your own system">
          {/* Cancel and "use the example" sit in the builder's own toolbar, so the page fits one screen. */}
          <BuilderScreen
            graph={canvas}
            onChange={setCanvas}
            problems={validateGraph(canvas)}
            onUse={() => useCanvas(canvas)}
            actions={
              <>
                {system.kind === 'custom' && (
                  <button type="button" className="csl-btn csl-btn--small" onClick={useExample}>
                    Use the example system instead
                  </button>
                )}
                <button type="button" className="csl-btn csl-btn--small" onClick={cancelBuilder} title="Back to the system as it was; your drawing is kept for next time">
                  Cancel
                </button>
              </>
            }
          />
        </section>
      )}
      {canvas === null && (
      <>
      {editingFailure && (
        <section className="csl-card csl-card--compact" aria-label="Change the failure">
          <h2 className="csl-section-title" style={{ margin: 0 }}>
            Choose a failure to simulate
          </h2>
          <ScenarioPicker scenarios={scenarioCatalog(system).map(({ id, title, blurb }) => ({ id, title, blurb }))} selected={scenarioId} onSelect={pickScenario} />
          <FailureEditor draft={draft} onChange={setDraft} onRun={run} dirty={dirty} />
        </section>
      )}

      <div data-tour="steps">
      <StepTabs
        compact
        steps={[
          // The verdict is not given away here: the replay reveals it when it gets there.
          { title: 'What happened', sub: main.status === 'error' ? "Couldn't simulate these settings" : main.status === 'cancelled' ? 'Stopped before it finished' : 'A short failure, replayed' },
          { title: "Where's the tipping point?", sub: `Traffic × ${applied.scenario.map.y.label}` },
          { title: 'Does a fix help?', sub: 'Fixes re-run against the same traffic' },
        ]}
        current={step}
        onSelect={setStep}
      />
      </div>

      <StepPanel active={step === 0} keep={keptSteps.includes(0)}>
        <div className="csl-split csl-split--stretch">
          <div className="csl-split__main">
            {main.status === 'done' && (
              <RunPlayer
                title="What happened"
                headingId="csl-step-heading"
                storyAbove={storyAbove}
                subtitle={`${applied.scenario.title}${edited ? ' (edited)' : ''} · ${applied.scenario.rps} requests/s · random run #${config.seed}`}
                topology={applied.topology}
                config={config}
                result={main.value}
                onEdit={openSettings}
                compact
                chartHeight={232}
                timelineTarget={timelineEl}
                holdPlayback={tour.open}
                demoAtMs={tour.open ? demoAtMs : null}
                openAtMs={replayOpenAtMs}
                restartKey={restartKey}
                guided
                story={story}
                endPanel={comparison && comparison.changes.length > 0 ? <RunComparison comparison={comparison} onDismiss={() => setPreviousRun(null)} /> : undefined}
              />
            )}
            {main.status === 'running' && (
              <PlayerPlaceholder text={`Simulating ${config.durationMs / 1000} s of traffic and its no-failure control…`} progress={main.progress} minHeight={MAIN_PLAYER_HEIGHT} onCancel={stopMain} />
            )}
            {main.status === 'error' && <SimulationError message={main.message} onEdit={() => openSettings(null)} onReset={resetToPreset} built={built} />}
            {main.status === 'cancelled' && <SimulationError stopped onEdit={() => openSettings(null)} onReset={resetToPreset} onRetry={retryMain} built={built} />}
          </div>
          <aside className="csl-split__col csl-split__side--narrow">
            <div className="csl-split__slot" ref={setTimelineEl} />
          </aside>
        </div>
      </StepPanel>
      <StepPanel active={step === 1} keep={keptSteps.includes(1)}>
        <TippingStep pool={pool} topology={applied.topology} scenario={applied.scenario} labels={labels} onEdit={openSettings} />
      </StepPanel>
      <StepPanel active={step === 2} keep={keptSteps.includes(2)}>
        {main.status === 'error' || main.status === 'cancelled' ? (
          <SimulationError message={main.status === 'error' ? main.message : undefined} stopped={main.status === 'cancelled'} onEdit={() => openSettings(null)} onReset={resetToPreset} onRetry={retryMain} built={built} />
        ) : (
          <FixStep pool={pool} topology={applied.topology} scenario={applied.scenario} config={config} original={main.status === 'done' ? main.value : null} labels={labels} onEdit={openSettings} />
        )}
      </StepPanel>
      </>
      )}

      <Drawer
        open={settings.open}
        title={settings.only === null ? 'All settings' : settings.only === 'client' ? 'Traffic settings' : `${labels[settings.only] ?? settings.only} settings`}
        subtitle={`${built ? 'Your system' : 'Preset'}: ${applied.scenario.title}. Changes apply to every step when you re-run.`}
        onClose={closeSettings}
        footer={
          <>
            {settings.only !== null ? (
              <button type="button" className="csl-btn csl-btn--link" onClick={() => openSettings(null)}>
                Edit all settings
              </button>
            ) : (
              <button type="button" className="csl-btn" onClick={() => setDraft(systemDraft(system, scenarioId))}>
                {built ? 'Reset to how you built it' : 'Reset to preset'}
              </button>
            )}
            {rerunBlocked && (
              <span className="csl-drawer__blocked" id="csl-rerun-why">
                {invalidFields.length > 0 ? `Fix "${invalidFields[0].label}" first` : 'Fix the problem above first'}
              </span>
            )}
            <button
              type="submit"
              form="csl-settings-form"
              className="csl-btn csl-btn--primary"
              // Never a silent no-op: blocked, it says why beside it, and a press shows what to fix.
              aria-disabled={rerunBlocked ? true : undefined}
              aria-describedby={rerunBlocked ? 'csl-rerun-why' : undefined}
              // Keeps the cursor in a half-typed field, so its text isn't swapped for the last valid value first.
              onMouseDown={(e) => e.preventDefault()}
            >
              Re-run simulation
            </button>
          </>
        }
      >
        <form
          id="csl-settings-form"
          ref={setSettingsForm}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (rerunBlocked || !e.currentTarget.checkValidity()) showWhyBlocked();
            else (run(), closeSettings());
          }}
        >
          <SettingsForm draft={draft} onChange={setDraft} only={settings.only} />
          {problems.length > 0 && (
            <ul className="csl-problems" role="alert" ref={problemList}>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </form>
      </Drawer>
      </main>
    </div>
    </AnnouncerProvider>
  );
}

/** Says "Simulating…" and "Simulation ready" in the page's live region as the main run starts and ends. */
function AnnounceRun({ status }: { status: Async<unknown>['status'] }) {
  const announce = useAnnounce();
  useEffect(() => {
    if (status === 'running') announce('Simulating…', 'run');
    else if (status === 'done') announce('Simulation ready.', 'run');
    else if (status === 'error') announce("These settings couldn't be simulated.", 'run');
  }, [status, announce]);
  return null;
}

/** ASSUMPTION: about the height of step 1's player at 1440 × 900 (measured), so the page doesn't jump when it appears. */
const MAIN_PLAYER_HEIGHT = 670;

/**
 * A run that could not be simulated, or that the viewer stopped (`stopped`): say why in plain
 * words and keep the way out (settings, the preset or how it was built, or running it anyway) on screen.
 */
function SimulationError({ message, stopped = false, onEdit, onReset, onRetry, built }: { message?: string; stopped?: boolean; onEdit: () => void; onReset: () => void; onRetry?: () => void; built: boolean }) {
  return (
    <section className="csl-card csl-card--compact" role="alert" aria-label={stopped ? 'Simulation stopped' : 'Simulation error'}>
      <h2 className="csl-card__title" id="csl-step-heading" tabIndex={-1}>
        {stopped ? 'You stopped this run before it finished' : "These settings couldn't be simulated"}
      </h2>
      <p className={stopped ? 'csl-status' : 'csl-error'} style={{ margin: 0 }}>
        {stopped ? 'Long runs (lots of traffic, or a long run time) take a while. Change the settings, or run it anyway.' : (message ?? '').replace(/^(Error: )?Invalid config: /, '')}
      </p>
      <div className="csl-row" style={{ gap: 8 }}>
        <button type="button" className="csl-btn csl-btn--primary" onClick={onEdit}>
          ⚙ Edit settings
        </button>
        <button type="button" className="csl-btn" onClick={onReset}>
          {built ? 'Reset to how you built it' : 'Reset to the preset'}
        </button>
        {stopped && onRetry && (
          <button type="button" className="csl-btn" onClick={onRetry}>
            Run it anyway
          </button>
        )}
      </div>
    </section>
  );
}

