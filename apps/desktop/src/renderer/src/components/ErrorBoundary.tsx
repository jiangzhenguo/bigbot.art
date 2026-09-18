/**
 * ErrorBoundary — 页面级错误边界
 *
 * 背景:TableEditor 空表读 tHead 崩溃曾导致整窗白屏(无边界,React 卸载整棵树)。
 * 任何子树渲染错误只降级为本面板,保留外壳可导航;错误进 console(渲染进程日志会转发主进程总线)。
 */
import React from 'react';

interface ErrorBoundaryProps {
  /** 边界名(哪个页面/区域),用于日志与展示 */
  name: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[ErrorBoundary·${this.props.name}] 渲染崩溃已拦截:`, error.message, info.componentStack ?? '');
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="err-boundary"
        data-od-id="error-boundary"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          height: '100%',
          padding: 32,
          color: 'var(--fg)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>「{this.props.name}」界面出现异常,已拦截避免白屏</div>
        <pre
          className="mono"
          style={{
            maxWidth: 560,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: 11,
            color: 'var(--mut, var(--fg-dim))',
            border: '1px solid var(--border-soft)',
            borderRadius: 8,
            padding: '10px 14px',
          }}
        >
          {error.message}
        </pre>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-s btn-sm" onClick={() => this.setState({ error: null })}>
            重试渲染
          </button>
          <button className="btn btn-p btn-sm" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
