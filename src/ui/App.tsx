import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildRunConfig } from '../data/buildConfig';
import { scenarios } from '../data/scenarios';
import { createDefaultPool, type SimPool } from '../worker/pool';
import { Drawer } from './components/Drawer';
import { ScenarioPicker } from './components/ScenarioPicker';
import { StepTabs } from './components/StepTabs';
import { presetDraft, type Draft } from './draft';
import { FailureEditor } from './FailureEditor';
import { RunPlayer } from './RunPlayer';
import { SettingsForm } from './SettingsForm';
import { TippingStep } from './TippingStep';
import { useAnalysis } from './useSimulation';
import { labelsOf, verdictView } from './viewModels';

const DEFAULT_SCENARIO = 'retry-storm';

export interface AppProps {
  /** Injected in tests; the app creates a Web Worker pool by default. */
  pool?: SimPool;
  /** Renders step 3 (fix suggestions); injected so the shell can be tested on its own. */
  renderFixes?: (args: { pool: SimPool; draft: Draft; labels: Record<string, string> }) => ReactNode;
}

/**
 * The page: pick a failure, then three steps (what happened → tipping point → does a fix help).
 * `applied` is what is simulated; `draft` holds edits until the viewer runs them.
 */
export function App({ pool: injected, renderFixes }: AppProps) {
  const pool = useMemo(() => injected ?? createDefaultPool(), [injected]);
  useEffect(() => () => {
    if (!injected) pool.dispose();
  }, [pool, injected]);

  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO);
  const [applied, setApplied] = useState<Draft>(() => presetDraft(DEFAULT_SCENARIO));
  const [draft, setDraft] = useState<Draft>(applied);
  const [step, setStep] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
  const run = () => setApplied(structuredClone(draft));
  const verdict = main.status === 'done' ? verdictView(main.value.analysis.recovery) : null;

  return (
    <main className="csl-page">
      <header className="csl-header">
        <div>
          <h1 className="csl-header__title">Chaos Simulation Lab</h1>
          <p className="csl-header__tagline">See where a system stops recovering on its own, and whether a fix moves that point.</p>
        </div>
        <button type="button" className="csl-btn" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </header>

      <section className="csl-card" aria-label="Scenario">
        <h2 className="csl-section-title" style={{ margin: 0 }}>
          Choose a failure to simulate
        </h2>
        <ScenarioPicker scenarios={Object.values(scenarios).map(({ id, title, blurb }) => ({ id, title, blurb }))} selected={scenarioId} onSelect={pickScenario} />
        <FailureEditor draft={draft} onChange={setDraft} onRun={run} dirty={dirty} />
      </section>

      <StepTabs
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
              autoPlay
            />
          )}
          {main.status === 'running' && <p className="csl-status">Simulating {config.durationMs / 1000} s of traffic and its no-failure control…</p>}
          {main.status === 'error' && <p className="csl-error">{main.message}</p>}
        </>
      )}
      {step === 1 && <TippingStep pool={pool} topology={applied.topology} scenario={applied.scenario} labels={labels} />}
      {step === 2 && (renderFixes ? renderFixes({ pool, draft: applied, labels }) : <p className="csl-status">Fix suggestions are not available.</p>)}

      <Drawer
        open={settingsOpen}
        title="Settings"
        subtitle={`Preset: ${applied.scenario.title} · every value is editable`}
        onClose={() => setSettingsOpen(false)}
        footer={
          <>
            <button type="button" className="csl-btn" onClick={() => setDraft(presetDraft(scenarioId))}>
              Reset to preset
            </button>
            <button type="button" className="csl-btn csl-btn--primary" onClick={() => (run(), setSettingsOpen(false))}>
              Re-run simulation
            </button>
          </>
        }
      >
        <SettingsForm draft={draft} onChange={setDraft} />
      </Drawer>
    </main>
  );
}
