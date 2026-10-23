import { useEffect, useMemo, useState } from 'react';
import { buildRunConfig } from '../data/buildConfig';
import { scenarios } from '../data/scenarios';
import { createDefaultPool, type SimPool } from '../worker/pool';
import { Drawer } from './components/Drawer';
import { ScenarioPicker } from './components/ScenarioPicker';
import { StepTabs } from './components/StepTabs';
import { presetDraft, type Draft } from './draft';
import { FailureEditor, ScenarioSummary } from './FailureEditor';
import { FixStep } from './FixStep';
import { RunPlayer } from './RunPlayer';
import { SettingsForm } from './SettingsForm';
import { TippingStep } from './TippingStep';
import { useAnalysis } from './useSimulation';
import { labelsOf, verdictView } from './viewModels';

const DEFAULT_SCENARIO = 'retry-storm';

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

  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO);
  const [applied, setApplied] = useState<Draft>(() => presetDraft(DEFAULT_SCENARIO));
  const [draft, setDraft] = useState<Draft>(applied);
  const [step, setStep] = useState(0);
  /** On steps 2 and 3 the scenario card collapses to one line to leave room for side-by-side views. */
  const [editingFailure, setEditingFailure] = useState(false);
  /** Settings drawer: closed, one tier ('client' = traffic), or every setting (null). */
  const [settings, setSettings] = useState<{ open: boolean; only: string | null }>({ open: false, only: null });
  const openSettings = (only: string | null) => setSettings({ open: true, only });
  const closeSettings = () => setSettings((s) => ({ ...s, open: false }));

  const labels = useMemo(() => labelsOf(applied.topology), [applied.topology]);
  const config = useMemo(() => buildRunConfig(applied.topology, applied.scenario), [applied]);
  const main = useAnalysis(pool, config, labels);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);

  const pickScenario = (id: string) => {
    const fresh = presetDraft(id);
    setScenarioId(id);
    setApplied(fresh);
    setDraft(fresh);
  };
  const run = () => (setApplied(structuredClone(draft)), setEditingFailure(false));
  const verdict = main.status === 'done' ? verdictView(main.value.analysis.recovery) : null;

  return (
    <main className="csl-page">
      <header className="csl-topbar">
        <h1 className="csl-topbar__title" title="See where a system stops recovering on its own, and whether a fix moves that point.">
          Chaos Simulation Lab
        </h1>
        <ScenarioSummary draft={applied} editing={editingFailure} onToggle={() => setEditingFailure((e) => !e)} />
      </header>

      {editingFailure && (
        <section className="csl-card csl-card--compact" aria-label="Change the failure">
          <h2 className="csl-section-title" style={{ margin: 0 }}>
            Choose a failure to simulate
          </h2>
          <ScenarioPicker scenarios={Object.values(scenarios).map(({ id, title, blurb }) => ({ id, title, blurb }))} selected={scenarioId} onSelect={pickScenario} />
          <FailureEditor draft={draft} onChange={setDraft} onRun={run} dirty={dirty} />
        </section>
      )}

      <StepTabs
        compact
        steps={[
          { title: 'What happened', sub: verdict ? verdict.text : 'Simulating…' },
          { title: "Where's the tipping point?", sub: `Traffic × ${applied.scenario.map.y.label}` },
          { title: 'Does a fix help?', sub: 'Fixes re-run against the same traffic' },
        ]}
        current={step}
        onSelect={setStep}
      />

      {step === 0 && (
        <>
          {main.status === 'done' && (
            <RunPlayer
              title="What happened"
              subtitle={`${applied.scenario.title} · ${applied.scenario.rps} requests/s · seed ${config.seed}`}
              topology={applied.topology}
              config={config}
              result={main.value}
              onEdit={openSettings}
            />
          )}
          {main.status === 'running' && <p className="csl-status">Simulating {config.durationMs / 1000} s of traffic and its no-failure control…</p>}
          {main.status === 'error' && <p className="csl-error">{main.message}</p>}
        </>
      )}
      {step === 1 && <TippingStep pool={pool} topology={applied.topology} scenario={applied.scenario} labels={labels} onEdit={openSettings} />}
      {step === 2 && (
        <FixStep pool={pool} topology={applied.topology} scenario={applied.scenario} config={config} original={main.status === 'done' ? main.value : null} labels={labels} onEdit={openSettings} />
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
              <button type="button" className="csl-btn" onClick={() => setDraft(presetDraft(scenarioId))}>
                Reset to preset
              </button>
            )}
            <button type="button" className="csl-btn csl-btn--primary" onClick={() => (run(), closeSettings())}>
              Re-run simulation
            </button>
          </>
        }
      >
        <SettingsForm draft={draft} onChange={setDraft} only={settings.only} />
      </Drawer>
    </main>
  );
}
