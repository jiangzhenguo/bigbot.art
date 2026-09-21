import { useCallback, useRef, useState } from 'react';
import { PromptDialog } from './PromptDialog';

export interface PromptOptions {
  title: string;
  initial?: string;
  placeholder?: string;
}

/**
 * 替代 window.prompt(Electron 不支持)的应用内输入弹层 hook。
 *
 * 用法:
 *   const { ask, dialog } = usePrompt();
 *   const v = await ask({ title: '重命名节点', initial: n.title }); // string | null
 *   render 里挂一次 <>{dialog}</>。
 *
 * 语义与 window.prompt 对齐:确定返回 trim 后的输入(空值 → null),取消/Esc/遮罩 → null。
 */
export function usePrompt() {
  const [opts, setOpts] = useState<PromptOptions | null>(null);
  const resolveRef = useRef<((v: string | null) => void) | null>(null);

  const ask = useCallback((o: PromptOptions): Promise<string | null> => {
    setOpts({ ...o, initial: o.initial ?? '' });
    return new Promise((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const close = useCallback((value: string | null) => {
    setOpts(null);
    const r = resolveRef.current;
    resolveRef.current = null;
    r?.(value);
  }, []);

  const dialog = opts ? (
    <PromptDialog
      title={opts.title}
      initial={opts.initial}
      placeholder={opts.placeholder}
      onCancel={() => close(null)}
      onConfirm={(v) => close(v.trim() || null)}
    />
  ) : null;

  return { ask, dialog };
}