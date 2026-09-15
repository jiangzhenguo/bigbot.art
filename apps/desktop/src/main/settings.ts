/**
 * AppSettings — 全局应用设置持久化(~/.bigbotart/settings.json)
 * - renderMode: demo(默认,一律 mock) / real(引擎就绪则真实推理;需 BIGBOTART_DRYRUN=0)
 * - llm: 全局默认 LLM 来源(项目级覆盖优先)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@bigbotart/shared';

const DATA_DIR = process.env.BIGBOTART_HOME ?? join(homedir(), '.bigbotart');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const DEFAULTS: AppSettings = {
  llm: { kind: 'lmstudio', model: 'ornith-1.5-35b-a3b-abliterated-mlx' },
  renderMode: 'demo',
  lmStudioModel: 'ornith-1.5-35b-a3b-abliterated-mlx',
  defaultTier: 'default',
};

export class SettingsStore {
  private data: AppSettings;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.data = this.read();
  }

  private read(): AppSettings {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    try {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private save() {
    writeFileSync(SETTINGS_FILE, JSON.stringify(this.data, null, 2));
  }

  get(): AppSettings {
    return { ...this.data };
  }

  patch(patch: Partial<AppSettings>): AppSettings {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.get();
  }
}