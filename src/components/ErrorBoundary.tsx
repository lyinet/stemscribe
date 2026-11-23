import React from "react";
import { RefreshCw } from "lucide-react";
import { t } from "../i18n";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  compact?: boolean;
  resetKey?: unknown;
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("StemScribe UI error:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error.stack || error.message || String(error);

    if (this.props.compact) {
      return (
        <div className="error-boundary-compact">
          <div className="error-boundary-title">
            {t("error.panelFailed", { label: this.props.label ?? "" })}
          </div>
          <pre className="error-boundary-detail">{message}</pre>
          <button className="btn btn-sm" onClick={this.reset}>
            <RefreshCw size={13} /> {t("error.retry")}
          </button>
        </div>
      );
    }

    return (
      <div className="error-boundary-full">
        <div className="error-boundary-title">{t("error.title")}</div>
        <pre className="error-boundary-detail">{message}</pre>
        <div className="error-boundary-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            {t("error.reload")}
          </button>
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard?.writeText(message).catch(() => {});
            }}
          >
            {t("error.copy")}
          </button>
        </div>
      </div>
    );
  }
}
