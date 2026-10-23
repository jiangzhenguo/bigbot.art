/**
 * AppSettings — 全局应用设置持久化(~/.bigbotart/settings.json)
 * - renderMode: demo(默认,一律 mock) / real(引擎就绪则真实推理;需 BIGBOTART_DRYRUN=0)
 * - llm: 全局默认 LLM 来源(项目级覆盖优先)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@bigbotart/shared';
import { sanitizeOpenCodeGoSettings } from './llm.js';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const DEFAULTS: AppSettings = {
  llm: { kind: 'lmstudio', model: 'ornith-1.5-35b-a3b-abliterated-mlx' },
  renderMode: 'demo',
  language: 'zh-CN',
  ssdStreaming: false,
  lmStudioModel: 'ornith-1.5-35b-a3b-abliterated-mlx',
  defaultTier: 'default',
};

export class SettingsStore {
  private data: AppSettings;
  private onWarn?: (msg: string) => void;

  constructor(opts: { onWarn?: (msg: string) => void } = {}) {
    this.onWarn = opts.onWarn;
    mkdirSync(DATA_DIR, { recursive: true });
    const { data, fixes } = this.read();
    this.data = data;
    // 自愈结果必须立刻落盘:否则每次启动都重复做同一次修正,用户也看不到改了什么
    if (fixes.length > 0) {
      for (const f of fixes) this.onWarn?.(`[settings] ${f}`);
      this.save();
    }
  }

  private read(): { data: AppSettings; fixes: string[] } {
    if (!existsSync(SETTINGS_FILE)) return { data: { ...DEFAULTS }, fixes: [] };
    try {
      const raw = { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) } as AppSettings;
      // 存量设置自愈(OpenCode Go 的非 Chat Completions 模型会让每轮对话 400,见 llm.ts)
      const { next, fixes } = sanitizeOpenCodeGoSettings(raw);
      return { data: next, fixes };
    } catch {
      return { data: { ...DEFAULTS }, fixes: [] };
    }
  }

  private save() {
    writeFileSync(SETTINGS_FILE, JSON.stringify(this.data, null, 2));
  }

  get(): AppSettings {
    return { ...this.data };
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    // 远程访问/中继的开关很容易在别处被顺手改掉,而且事后极难追查
    // (症状是「隧道莫名其妙不连了」)。谁动过、动成什么样,这里留一行痕。
    if ('remoteAccess' in patch) {
      console.warn('[settings] remoteAccess 被修改:', JSON.stringify(patch.remoteAccess));
    }
    this.data = { ...this.data, ...patch };
    // theme 由调用方(IPC)先 normalize;此处兜底非法写入
    if (this.data.theme !== undefined && this.data.theme !== 'system' && this.data.theme !== 'light' && this.data.theme !== 'dark') {
      this.data.theme = 'system';
    }
    this.save();
    return this.get();
  }
}