/**
 * PageTopBar — 页面级公共顶部栏(返回 + 面包屑 + 动作区)
 *
 * 背景:canvas / assets / skills / timeline 各页 topbar 结构一致
 * (← 返回目标 · sep · 面包屑 · 动作/筛选/搜索…),此前各自手写导致
 * 返回逻辑与 UI 漂移(如资源管理页曾用未定义的 projhero/libhero 类)。
 *
 * 样式由各页面作用域的 .topbar / .btn / .sep / .crumb 提供
 * (styles/design-pages.css 的 .pg-assets / .pg-skills 等),本组件
 * 只统一结构与返回交互,不自带样式。
 */
import React from 'react';
import { useT } from '../i18n';

interface PageTopBarProps {
  /** 返回按钮文案(返回目标名),如「画布」「首页」 */
  backLabel: string;
  /** 点击返回;目标页由容器(通常是 App 导航栈)决定 */
  onBack: () => void;
  /** 面包屑内容,如 资源管理 › 总资源库;缺省不渲染 */
  crumb?: React.ReactNode;
  /** data-od-id 前缀:工具条为 `<odId>-toolbar`,返回按钮为 `<odId>-back` */
  odId: string;
  /** 右侧动作区(按钮 / 筛选 / 搜索等) */
  children?: React.ReactNode;
}

export default function PageTopBar({ backLabel, onBack, crumb, odId, children }: PageTopBarProps) {
  const t = useT();
  return (
    <header className="topbar" data-od-id={`${odId}-toolbar`}>
      <button className="btn btn-g btn-sm" data-od-id={`${odId}-back`} title={t('返回{label}', { label: backLabel })} onClick={onBack}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
          <path d="m14 6-6 6 6 6" />
        </svg>
        {backLabel}
      </button>
      {crumb ? (
        <>
          <span className="sep" />
          <span className="crumb" data-od-id={`${odId}-crumb`}>
            {crumb}
          </span>
        </>
      ) : null}
      {children}
    </header>
  );
}
