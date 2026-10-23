/**
 * 全屏「加载中」遮罩 —— 给「换页 / 打开画布」这类重活一个交代。
 *
 * ## 为什么需要它(2026-10-23,iPad 网页端实测)
 *
 * 换页要**卸载整张画布**(几十~几百个节点 DOM + SVG 连线)再挂载新页,
 * 这一段是**同步**的:浏览器在它跑完之前没法 paint,用户看到的是「整页卡死」。
 * 公网链路只有 ~350KB/s,这段时间被拉得更长,更像「App 没反应」而不是「在加载」。
 *
 * ## 关键在「先上屏、再干活」
 *
 * React 提交 DOM 之后浏览器才有机会 paint。所以调用方必须:
 *   ① setState(挂上遮罩) → ② **等一帧** → ③ 再做重活。
 * 若遮罩和重活在同一帧里,遮罩等于没加(重活跑完才 paint,直接跳到结果)。
 * `nextPaint()`(App.tsx)就是这个「等一帧」。
 *
 * ## 遮罩自己也不能卡死
 *
 * 加载失败/流程异常时必须能撤掉:调用方负责在出错路径清掉遮罩,
 * App 里另有 30s 兜底定时器(见 App.tsx),避免「一直转圈」比「卡住」更糟。
 */
export function LoadingOverlay({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="app-loading" role="status" aria-live="polite" data-od-id="app-loading">
      <div className="app-loading-box">
        <span className="app-loading-spin" aria-hidden="true" />
        <span className="app-loading-text">{text}</span>
        {hint ? <span className="app-loading-hint">{hint}</span> : null}
      </div>
    </div>
  );
}
