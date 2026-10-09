/**
 * 项目封面(渲染层)—— 把首页/项目页那张静态假图换成项目真实产物
 *
 * 分工:**解析在主进程**(`main/project-cover.ts` 有磁盘视野与画布快照),
 * 渲染层只负责「拿到 path 后怎么显示」:
 *  - `path === null` → 占位(项目还没出过图,这是**正常状态**,不是错误)
 *  - `isVideo` → 抽首帧(VideoPoster;直接塞 <img> 必然 onerror,见 media.tsx 注释)
 *  - 其余 → 直接用现成的 `previewUrlOf`(产物走 bba-output、资产走 bba-asset)
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProjectCover } from '@bigbotart/shared';
import { previewUrlOf } from '../pages/canvas/media';
import { VideoPoster } from '../pages/canvas/media';

export interface UseProjectCoversResult {
  /** projectId → 封面(未加载完的项目不在表里) */
  covers: Record<string, ProjectCover>;
  loading: boolean;
  /** 重新拉取(上传/清除封面后调用) */
  refresh: () => void;
}

/**
 * 批量拉取项目封面。首页/项目页共用 —— 一次 IPC 拿全部,避免 N 个项目 N 次往返。
 *
 * `refreshKey` 变化即重拉:上传/清除封面后由调用方 bump 它。
 */
export function useProjectCovers(refreshKey = 0): UseProjectCoversResult {
  const [covers, setCovers] = useState<Record<string, ProjectCover>>({});
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    window.bigbotart
      .projectCovers()
      .then((list) => {
        if (!alive) return;
        const m: Record<string, ProjectCover> = {};
        for (const c of list) m[c.projectId] = c;
        setCovers(m);
      })
      .catch((e) => console.error('读取项目封面失败', e))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refreshKey, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { covers, loading, refresh };
}

/**
 * 封面图:自动处理「视频抽帧 / 图片直出 / 加载失败降级」。
 *
 * **失败降级是必须的**:路径存在不等于浏览器能解码(文件损坏、编码不支持)。
 * 破图(alt 文本 + 碎图标)比占位图更像故障,所以 onError 一律回落到占位。
 */
export function ProjectCoverImage({
  cover,
  alt,
  placeholder,
  style,
}: {
  cover: ProjectCover | undefined;
  alt: string;
  /** 无封面时显示的内容(由调用方给,保持两页视觉各自一致) */
  placeholder: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const src = cover?.path ? previewUrlOf(cover.path) : null;

  // 换项目/换封面时清掉失败态,否则上一张的失败会粘住下一张
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) return <>{placeholder}</>;
  if (cover?.isVideo) {
    return <VideoPoster src={src} alt={alt} style={style} />;
  }
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      onError={() => setFailed(true)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', ...style }}
    />
  );
}
