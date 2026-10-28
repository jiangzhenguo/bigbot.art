/** 远程访问一次性口令：输入框旁必须带显式复制按钮。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RemotePassphraseRow } from '../RemoteAccessSection';

describe('RemotePassphraseRow', () => {
  it('在 Token 右侧渲染只读输入框与复制按钮', () => {
    const html = renderToStaticMarkup(
      React.createElement(RemotePassphraseRow, {
        passphrase: 'test-remote-token-123',
        copyLabel: '复制',
        inputLabel: '口令(只显示这一次)',
      }),
    );
    expect(html).toContain('data-od-id="settings-remote-passphrase"');
    expect(html).toContain('value="test-remote-token-123"');
    expect(html).toContain('readonly=""');
    expect(html).toContain('remote-token-copy');
    expect(html).toContain('>复制</span>');
    expect(html.indexOf('settings-remote-passphrase')).toBeLessThan(html.indexOf('remote-token-copy'));
  });
});
