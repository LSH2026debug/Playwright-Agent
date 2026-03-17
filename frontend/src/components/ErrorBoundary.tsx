import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary 组件
 * 捕获子组件树中的JavaScript错误，防止整个应用崩溃
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="error-boundary-fallback">
          <h2>应用出现错误</h2>
          <p>抱歉，应用遇到了问题。请尝试刷新页面。</p>
          {this.state.error && (
            <details>
              <summary>错误详情</summary>
              <pre>{this.state.error.message}</pre>
            </details>
          )}
          <button onClick={this.handleReset} type="button">
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
