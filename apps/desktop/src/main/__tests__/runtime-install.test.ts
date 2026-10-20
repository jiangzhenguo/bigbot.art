import { describe, expect, it } from 'vitest';
import { legacyMlxgenToolConflict } from '../runtime-install';

describe('legacyMlxgenToolConflict', () => {
  it('旧工具占着 mlxgen 入口 → 需要先卸', () => {
    expect(
      legacyMlxgenToolConflict("error: Executable `mlxgen` already exists from tool `mlx-gen`"),
    ).toBe(true);
    expect(
      legacyMlxgenToolConflict('entry point mlxgen conflicts with existing tool mlx-gen'),
    ).toBe(true);
  });

  it('只说可执行文件已存在、不点名工具 → 仍视为冲突', () => {
    expect(legacyMlxgenToolConflict('Executable `mlxgen` already exists')).toBe(true);
  });

  it('新包名 mlx-gen-jzg 本身不算旧工具冲突', () => {
    expect(
      legacyMlxgenToolConflict('error: Failed to download distribution mlx-gen-jzg'),
    ).toBe(false);
    expect(
      legacyMlxgenToolConflict('No solution found when resolving tool dependencies for mlx-gen-jzg'),
    ).toBe(false);
  });

  it('普通安装失败(网络/退出码)不触发卸载', () => {
    expect(legacyMlxgenToolConflict('error: Request failed after 3 retries')).toBe(false);
    expect(legacyMlxgenToolConflict('')).toBe(false);
  });
});
