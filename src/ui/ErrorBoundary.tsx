import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called when the viewer asks to start again, before the page is shown afresh. */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on reset so the page below mounts afresh (its state is what broke). */
  attempt: number;
}

/**
 * The last line of defence (REVIEW2 2.7): if anything on the page throws while rendering, the
 * viewer sees a plain message and a way to start again instead of a blank page. The message
 * names what went wrong in the browser's words, for a bug report.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console for whoever investigates; the page itself shows a plain message.
    console.error('The page stopped working:', error, info.componentStack);
  }

  private reset = () => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    const { error, attempt } = this.state;
    if (error === null) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    return (
      <main className="csl-page">
        <section className="csl-card csl-crash" role="alert" aria-label="Something went wrong">
          <h1 className="csl-card__title">Something went wrong</h1>
          <p style={{ margin: 0 }}>The page hit a problem it couldn't recover from. Your browser said:</p>
          <p className="csl-error csl-mono" style={{ margin: 0 }}>
            {error.message || 'An unknown error'}
          </p>
          <div className="csl-row" style={{ gap: 8 }}>
            <button type="button" className="csl-btn csl-btn--primary" onClick={this.reset}>
              Start again
            </button>
          </div>
        </section>
      </main>
    );
  }
}
