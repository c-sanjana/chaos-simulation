import { App, type AppProps } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { forgetSaved } from './savedSystem';

/**
 * The page inside its last line of defence (ErrorBoundary). "Start again" also forgets the system
 * remembered in this browser: if a damaged save got past loadSaved's checks and broke the page,
 * remounting would read it again and break the page on every load.
 */
export function Root({ pool }: AppProps) {
  return (
    <ErrorBoundary onReset={() => forgetSaved()}>
      <App pool={pool} />
    </ErrorBoundary>
  );
}
