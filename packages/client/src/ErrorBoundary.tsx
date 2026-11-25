import { Component, type ReactNode } from "react";

/** If something breaks while drawing, show a way back instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app notice">
        <h1>Something went wrong</h1>
        <p className="muted">Reloading puts you back in your game.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}
