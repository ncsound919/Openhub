import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Route-level error boundary. Without one, a single render throw in any of the
 * lazily-loaded pages white-screens the whole shell. This keeps the failure
 * contained to a recoverable panel.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[OpenHub] render error:', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="min-h-[320px] flex items-center justify-center p-6">
        <div className="industrial-card max-w-lg w-full p-6 flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">This view failed to render</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            The page hit an unexpected error. Your session and data are unaffected.
          </p>
          <pre className="text-xs font-mono text-[var(--color-danger)] whitespace-pre-wrap break-words max-h-40 overflow-auto">
            {error.message}
          </pre>
          <div className="flex gap-2 pt-1">
            <button
              onClick={this.handleReset}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]"
            >
              Try again
            </button>
            <button
              onClick={this.handleReload}
              className="px-3 py-1.5 rounded-md text-sm font-medium border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
