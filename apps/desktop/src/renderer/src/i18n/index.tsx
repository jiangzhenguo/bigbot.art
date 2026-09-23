/**
 * i18n — 界面语言(zh-CN 默认 / en)
 *
 * 设计决策:
 * - 以中文原文为字典 key(免维护 key 命名,增量覆盖;缺译自动回退中文,不会白屏)
 * - t('已导入 {n} 项资源', { n }) 支持 {var} 插值
 * - 语言持久化在 AppSettings.language(~/.bigbotart/settings.json),App 启动时回填,
 *   设置页「通用 › 语言」切换即写盘
 * - 覆盖范围(v1):全局 chrome(页面名/返回)+ home / assets / skills / projects / settings;
 *   canvas / agent / timeline 深区文案仍为中文——后续只需补字典 + 包 t(),无需改结构
 */
import React, { createContext, useContext, useMemo } from 'react';
import common from './en/common';
import home from './en/home';
import assets from './en/assets';
import skills from './en/skills';
import projects from './en/projects';
import settings from './en/settings';

export type Lang = 'zh-CN' | 'en';

const EN: Record<string, string> = {
  ...common,
  ...home,
  ...assets,
  ...skills,
  ...projects,
  ...settings,
};

/** 非 hook 版翻译(App 根组件在 Provider 之外,用它算返回按钮文案) */
export function translate(lang: Lang, s: string, vars?: Record<string, string | number>): string {
  let out = lang === 'en' ? EN[s] ?? s : s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

export interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (s: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ lang, setLang, children }: { lang: Lang; setLang: (l: Lang) => void; children: React.ReactNode }) {
  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      t: (s, vars) => translate(lang, s, vars),
    }),
    [lang, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 取 t();未包 Provider 时原样返回(测试/兜底安全) */
export function useT(): I18nValue['t'] {
  const ctx = useContext(I18nContext);
  if (!ctx) return (s) => s;
  return ctx.t;
}

/** 取完整语言上下文(设置页语言切换用) */
export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) return { lang: 'zh-CN', setLang: () => undefined, t: (s) => s };
  return ctx;
}
