import React from "react";
import { RefreshCw } from "lucide-react";

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
            {this.props.label ? `「${this.props.label}」` : ""}面板渲染出错
          </div>
          <pre className="error-boundary-detail">{message}</pre>
          <button className="btn btn-sm" onClick={this.reset}>
            <RefreshCw size={13} /> 重试
          </button>
        </div>
      );
    }

    return (
      <div className="error-boundary-full">
        <div className="error-boundary-title">界面出现了问题</div>
        <pre className="error-boundary-detail">{message}</pre>
        <div className="error-boundary-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard?.writeText(message).catch(() => {});
            }}
          >
            复制错误信息
          </button>
        </div>
      </div>
    );
  }
}
