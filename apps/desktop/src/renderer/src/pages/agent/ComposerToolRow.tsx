/**
 * 输入区工具行:参考图导入、模型选择、技能激活。
 * 从 AgentComposer 拆出,避免输入区单文件继续堆高。
 */
import type { Dispatch, SetStateAction } from 'react';
import type { Asset, Skill } from '@bigbotart/shared';
import type { ModelOption } from './types';

export function ComposerToolRow({
  toastMsg,
  setAttachments,
  openPop,
  setOpenPop,
  model,
  modelOptions,
  loadModelOptions,
  pickModel,
  skillOptions,
  activeSkill,
  activateSkill,
  deactivateSkill,
}: {
  toastMsg: (msg: string) => void;
  setAttachments: Dispatch<SetStateAction<Asset[]>>;
  openPop: string | null;
  setOpenPop: Dispatch<SetStateAction<string | null>>;
  model: string;
  modelOptions: ModelOption[];
  loadModelOptions: () => Promise<void> | void;
  pickModel: (m: ModelOption) => void;
  skillOptions: Skill[];
  activeSkill: { skillId: string; name: string; inject?: 'full' | 'summary' } | null;
  activateSkill: (skill: { skillId: string; name: string; inject?: 'full' | 'summary' }) => void;
  deactivateSkill: () => void;
}) {
  return (
    <div className="toolrow">
      <button
        className="chip"
        onClick={(e) => {
          e.stopPropagation();
          // dev/E2E 钩子:一次性消费——读出即删,避免残留导致之后每次点击都绕过 Finder 重复导入同一张图
          const win = window as unknown as { __bbaDevImportPaths?: string[] };
          const paths = win.__bbaDevImportPaths;
          delete win.__bbaDevImportPaths;
          void window.bigbotart
            .importAssets(paths?.length ? { paths } : undefined)
            .then((res) => {
              if (res.canceled || !res.assets?.length) return;
              // 按资产 id 去重,同一资产重复导入只保留一个 chip
              setAttachments((list) => [...list, ...res.assets.filter((a) => !list.some((x) => x.id === a.id))]);
              if (res.failed.length) {
                toastMsg(`已导入 ${res.assets.length} 个;失败 ${res.failed.length}:${res.failed.map((f) => f.name).join(', ')}`);
              }
            });
        }}
      >
        ＋ 参考图 / 文件
      </button>
      <button
        className="chip"
        onClick={(e) => {
          e.stopPropagation();
          const opening = openPop !== 'modelPop';
          setOpenPop((p) => (p === 'modelPop' ? null : 'modelPop'));
          if (opening) void loadModelOptions();
        }}
      >
        模型:{model}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className={`pop${openPop === 'modelPop' ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
        {modelOptions.map((m) => (
          <div
            className="pop-it"
            key={m.name}
            onClick={() => {
              pickModel(m);
              setOpenPop(null);
            }}
          >
            {m.sub}
            {model === m.name ? <span className="ck">✓</span> : null}
          </div>
        ))}
        <div
          className="pop-it dim"
          style={{
            borderTop: '1px solid var(--border-soft)',
            marginTop: 4,
            paddingTop: 9,
          }}
        >
          项目级覆盖 · 规划时优先使用该 LLM
        </div>
      </div>
      <button
        className="chip"
        onClick={(e) => {
          e.stopPropagation();
          setOpenPop((p) => (p === 'skillPop' ? null : 'skillPop'));
        }}
      >
        ＋ 技能
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className={`pop${openPop === 'skillPop' ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div
          className="pop-it"
          onClick={() => {
            deactivateSkill();
            setOpenPop(null);
          }}
        >
          无技能 · 自由编排
          {!activeSkill ? <span className="ck">✓</span> : null}
        </div>
        {skillOptions.map((s) => (
          <div
            className="pop-it"
            key={s.id}
            onClick={() => {
              activateSkill({ skillId: s.id, name: s.name, inject: s.inject });
              setOpenPop(null);
            }}
          >
            {s.name}
            {s.instructions ? <span className="mut mono" style={{ fontSize: 10 }}> · 指令</span> : null}
            {activeSkill?.skillId === s.id ? <span className="ck">✓</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
