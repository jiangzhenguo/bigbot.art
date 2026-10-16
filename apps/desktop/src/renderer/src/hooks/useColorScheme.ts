/**
 * 解析后的外观(light / dark)——跟随 `prefers-color-scheme`。
 * 主进程 `nativeTheme.themeSource` 是唯一开关源;本 hook 只读媒体查询,
 * 并给 `<html>` 写 `data-theme`(调试 / E2E 定位用,样式不依赖它)。
 */
import { useEffect, useState } from 'react';

export type ColorScheme = 'light' | 'dark';

function readScheme(): ColorScheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncDataTheme(scheme: ColorScheme): void {
  document.documentElement.setAttribute('data-theme', scheme);
}

/** 返回当前解析外观,并在系统/themeSource 变化时更新;卸载时清理监听 */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() =>
    typeof window === 'undefined' ? 'light' : readScheme(),
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const next = mq.matches ? 'dark' : 'light';
      setScheme(next);
      syncDataTheme(next);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return scheme;
}
