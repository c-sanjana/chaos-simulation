import { useEffect, useMemo, useRef, useState } from 'react';
import { buildStory } from '../analysis/story';
import { buildRunConfig } from '../data/buildConfig';
import { graphFromPreset, syncGraph } from '../builder/fromPreset';
import type { BuilderGraph } from '../builder/graph';
import { validateGraph } from '../builder/validate';
import { createDefaultPool, type SimPool } from '../worker/pool';
import { compareRuns, type RunSnapshot } from './compare';
import { Drawer } from './components/Drawer';
import { RunComparison } from './components/RunComparison';
import { ScenarioPicker } from './components/ScenarioPicker';
import { StepTabs } from './components/StepTabs';
import { Tour, TourButton } from './components/Tour';
import { BuilderScreen } from './builder/BuilderScreen';
import { draftProblems, type Draft } from './draft';
import { AnnouncerProvider, useAnnounce } from './components/Announcer';
import { FailureEditor, ScenarioSummary } from './FailureEditor';
import { FixStep } from './FixStep';
import { RunPlayer } from './RunPlayer';
import { SettingsForm } from './SettingsForm';
import { customSystem, PRESET_SYSTEM, scenarioCatalog, systemDraft, type System } from './system';
import { ThemeToggle } from './themeMode';
import { TippingStep } from './TippingStep';
import { tourStops } from './tourStops';
import { usePendingFocus } from './usePendingFocus';
import { useTour } from './useTour';
import { useAnalysis, type Async } from './useSimulation';
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
  const pool = useMemo(() => injected ?? createDefaultPool(), [injected]);
  useEffect(() => () => {
    if (!injected) pool.dispose();
  }, [pool, injected]);

  /** The example system, or one built on the canvas; `canvas` holds the drawing while the builder is open. */
  const [system, setSystem] = useState<System>(PRESET_SYSTEM);
  const [canvas, setCanvas] = useState<BuilderGraph | null>(null);
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO);
  const [applied, setApplied] = useState<Draft>(() => systemDraft(PRESET_SYSTEM, DEFAULT_SCENARIO));
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
  const main = useAnalysis(pool, config, labels);
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
  const beforeDemo = useRef<{ system: System; scenarioId: string; applied: Draft; draft: Draft; canvas: BuilderGraph | null } | null>(null);
  const startTour = () => {
    setTourFrom(step);
    const demo = systemDraft(PRESET_SYSTEM, DEFAULT_SCENARIO);
    if (system.kind !== 'preset' || canvas !== null || JSON.stringify(applied) !== JSON.stringify(demo) || JSON.stringify(draft) !== JSON.stringify(demo)) {
      beforeDemo.current = { system, scenarioId, applied, draft, canvas };
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
  const endTour = (completed: boolean) => {
    tour.close(completed);
    focusAfter(FOCUS.help);
    setStep(tourFrom);
    setDemoAtMs(null);
    const back = beforeDemo.current;
    beforeDemo.current = null;
    if (back) {
      setSystem(back.system);
      setScenarioId(back.scenarioId);
      setApplied(back.applied);
      setDraft(back.draft);
      setCanvas(back.canvas);
      lastRun.current = null;
      setPreviousRun(null);
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const problems = draftProblems(draft);

  const pickScenario = (id: string) => {
    if (id === scenarioId && !dirty) return; // already showing this preset; don't wipe the viewer's settings
    const fresh = systemDraft(system, id);
    setScenarioId(id);
    setApplied(fresh);
    setDraft(fresh);
  };
  /** Applies the edits; focus then goes to the step's heading once the new run is ready. */
  const run = () => (setApplied(structuredClone(draft)), setEditingFailure(false), focusAfter(FOCUS.stepHeading, true));
  const resetToPreset = () => {
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
  };
  // The canvas opens on the system being simulated, with any settings changed since it was drawn.
  const openBuilder = () => {
    setCanvas(system.kind === 'custom' ? syncGraph(system.graph, applied.topology, applied.scenario.rps) : graphFromPreset(applied.topology, applied.scenario.rps));
    focusAfter(FOCUS.builderHeading);
  };
  /** Leaves the builder (after Cancel, Use, or "Use the example system instead"), back on the Build/Edit button. */
  const closeBuilder = () => (setCanvas(null), focusAfter(FOCUS.buildButton));
  const useCanvas = (graph: BuilderGraph) => (switchSystem(customSystem(graph)), closeBuilder());

  return (
    <AnnouncerProvider>
    <AnnounceRun status={main.status} />
    <div className="csl-page">
      <header className="csl-topbar">
        <h1 className="csl-topbar__title" title="See where a system stops recovering on its own, and whether a fix moves that point.">
          Chaos Simulation Lab
        </h1>
        <div data-tour="scenario" className="csl-topbar__summary">
          <ScenarioSummary draft={applied} editing={editingFailure} onToggle={() => setEditingFailure((e) => !e)} />
        </div>
        <div className="csl-topbar__actions">
          {canvas === null && (
            <button type="button" id="csl-build-button" className="csl-btn csl-btn--small" onClick={openBuilder}>
              {system.kind === 'custom' ? '✎ Edit your system' : '✎ Build your own system'}
            </button>
          )}
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

      {canvas !== null && (
        <section id="csl-builder" className="csl-card csl-card--compact csl-builder-page" aria-label="Build your own system">
          <div className="csl-builder-page__head">
            <span className="csl-builder-page__note">A chain for now: each part calls one next part, plus a cache. Branching is coming next.</span>
            {system.kind === 'custom' && (
              <button type="button" className="csl-btn csl-btn--small" onClick={() => (switchSystem(PRESET_SYSTEM), closeBuilder())}>
                Use the example system instead
              </button>
            )}
            <button type="button" className="csl-btn csl-btn--small" onClick={closeBuilder}>
              Cancel
            </button>
          </div>
          <BuilderScreen graph={canvas} onChange={setCanvas} problems={validateGraph(canvas)} onUse={() => useCanvas(canvas)} />
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
          { title: 'What happened', sub: main.status === 'error' ? "Couldn't simulate these settings" : 'A short failure, replayed' },
          { title: "Where's the tipping point?", sub: `Traffic × ${applied.scenario.map.y.label}` },
          { title: 'Does a fix help?', sub: 'Fixes re-run against the same traffic' },
        ]}
        current={step}
        onSelect={setStep}
      />
      </div>

      {step === 0 && (
        <div className="csl-split csl-split--stretch">
          <div className="csl-split__main">
            {main.status === 'done' && (
              <RunPlayer
                title="What happened"
                headingId="csl-step-heading"
                storyAbove={storyAbove}
                subtitle={`${applied.scenario.title} · ${applied.scenario.rps} requests/s · seed ${config.seed}`}
                topology={applied.topology}
                config={config}
                result={main.value}
                onEdit={openSettings}
                compact
                chartHeight={232}
                timelineTarget={timelineEl}
                holdPlayback={tour.open}
                demoAtMs={tour.open ? demoAtMs : null}
                guided
                story={story}
                endPanel={comparison && comparison.changes.length > 0 ? <RunComparison comparison={comparison} onDismiss={() => setPreviousRun(null)} /> : undefined}
              />
            )}
            {main.status === 'running' && <p className="csl-status">Simulating {config.durationMs / 1000} s of traffic and its no-failure control…</p>}
            {main.status === 'error' && <SimulationError message={main.message} onEdit={() => openSettings(null)} onReset={resetToPreset} />}
          </div>
          <aside className="csl-split__col csl-split__side--narrow">
            <div className="csl-split__slot" ref={setTimelineEl} />
          </aside>
        </div>
      )}
      {step === 1 && <TippingStep pool={pool} topology={applied.topology} scenario={applied.scenario} labels={labels} onEdit={openSettings} />}
      {step === 2 && (
        main.status === 'error' ? (
          <SimulationError message={main.message} onEdit={() => openSettings(null)} onReset={resetToPreset} />
        ) : (
          <FixStep pool={pool} topology={applied.topology} scenario={applied.scenario} config={config} original={main.status === 'done' ? main.value : null} labels={labels} onEdit={openSettings} />
        )
      )}
      </>
      )}

      <Drawer
        open={settings.open}
        title={settings.only === null ? 'All settings' : settings.only === 'client' ? 'Traffic settings' : `${labels[settings.only] ?? settings.only} settings`}
        subtitle={`Preset: ${applied.scenario.title}. Changes apply to every step when you re-run.`}
        onClose={closeSettings}
        footer={
          <>
            {settings.only !== null ? (
              <button type="button" className="csl-btn csl-btn--link" onClick={() => openSettings(null)}>
                Edit all settings
              </button>
            ) : (
              <button type="button" className="csl-btn" onClick={() => setDraft(systemDraft(system, scenarioId))}>
                Reset to preset
              </button>
            )}
            <button type="submit" form="csl-settings-form" className="csl-btn csl-btn--primary" disabled={problems.length > 0}>
              Re-run simulation
            </button>
          </>
        }
      >
        <form
          id="csl-settings-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (e.currentTarget.checkValidity() && problems.length === 0) (run(), closeSettings());
          }}
        >
          <SettingsForm draft={draft} onChange={setDraft} only={settings.only} />
          {problems.length > 0 && (
            <ul className="csl-problems" role="alert">
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

/** A run that could not be simulated: say why in plain words and keep the way out (settings, preset) on screen. */
function SimulationError({ message, onEdit, onReset }: { message: string; onEdit: () => void; onReset: () => void }) {
  return (
    <section className="csl-card csl-card--compact" role="alert" aria-label="Simulation error">
      <h2 className="csl-card__title" id="csl-step-heading" tabIndex={-1}>
        These settings couldn't be simulated
      </h2>
      <p className="csl-error" style={{ margin: 0 }}>
        {message.replace(/^(Error: )?Invalid config: /, '')}
      </p>
      <div className="csl-row" style={{ gap: 8 }}>
        <button type="button" className="csl-btn csl-btn--primary" onClick={onEdit}>
          ⚙ Edit settings
        </button>
        <button type="button" className="csl-btn" onClick={onReset}>
          Reset to the preset
        </button>
      </div>
    </section>
  );
}

