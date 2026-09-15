/**
 * 引擎注册表 — 唯一选择渲染后端的地方(对应 PRD §5.3.4)
 */
import type { Provider, ProviderId, ProviderRegistry, ProviderStatus } from '@bigbotart/shared';
import { H3cProvider, type H3cProviderOptions } from './h3c.js';
import { MlXGenProvider, type MlXGenProviderOptions } from './mlxgen.js';
import { MockProvider } from './mock.js';

export { H3cProvider, MlXGenProvider, MockProvider };
export * from './h3c-command.js';

export interface ProviderFactoryOptions {
  h3c?: H3cProviderOptions;
  mlxgen?: MlXGenProviderOptions;
  /** 允许注入自定义 Provider */
  extra?: Provider[];
}

/**
 * 骨架期默认全 dryRun(不真实推理,但探测真实、命令构造真实);
 * 通过环境变量 BIGBOTART_DRYRUN=0 关闭 dryRun 启用真实执行。
 */
export function createRegistry(opts: ProviderFactoryOptions = {}): ProviderRegistry {
  const dryRun = process.env.BIGBOTART_DRYRUN !== '0';
  const providers: Provider[] = [
    new H3cProvider({ ...opts.h3c, dryRun: opts.h3c?.dryRun ?? dryRun }),
    new MlXGenProvider({ ...opts.mlxgen, dryRun: opts.mlxgen?.dryRun ?? dryRun }),
    new MockProvider(),
    ...(opts.extra ?? []),
  ];

  const map = new Map<ProviderId, Provider>();
  for (const p of providers) map.set(p.id, p);

  return {
    list: () => providers,
    get: (id) => map.get(id),
    async checkAll() {
      const out = {} as Record<ProviderId, ProviderStatus>;
      for (const p of providers) out[p.id] = await p.check();
      return out;
    },
  };
}