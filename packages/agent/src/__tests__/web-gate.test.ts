import { describe, it, expect } from 'vitest';
import { fetchImageNeedsConfirm, userCorpusFromChat, userSuppliedImageUrl } from '../web-gate.js';

const URL = 'https://cdn.example.com/ref.png';

describe('图片地址是否由用户给出', () => {
  it('完整地址、省略协议、末尾标点都算用户指定过', () => {
    expect(userSuppliedImageUrl(`请用这张 ${URL}`, URL)).toBe(true);
    expect(userSuppliedImageUrl(`看 ${URL}。`, URL)).toBe(true);
    expect(userSuppliedImageUrl('cdn.example.com/ref.png 当参考', URL)).toBe(true);
  });

  it('搜索摘要和空文本不算授权', () => {
    expect(userSuppliedImageUrl('', URL)).toBe(false);
    expect(userSuppliedImageUrl('帮我找一张庭院参考', URL)).toBe(false);
    expect(userSuppliedImageUrl('file:///tmp/a.png', 'file:///tmp/a.png')).toBe(false);
  });

  it('语料只拼 user 消息', () => {
    const corpus = userCorpusFromChat('就用刚才那张', [
      { role: 'user', content: `参考 ${URL}` },
      { role: 'system', content: `搜索到 ${URL}` },
      { role: 'assistant', content: URL },
    ]);
    expect(corpus).toContain('参考');
    expect(corpus).not.toContain('搜索到');
    expect(userSuppliedImageUrl(corpus, URL)).toBe(true);
    const onlySystem = userCorpusFromChat('下载吧', [
      { role: 'system', content: URL },
    ]);
    expect(fetchImageNeedsConfirm({ url: URL }, onlySystem)).toBe(true);
    expect(fetchImageNeedsConfirm({ url: URL }, corpus)).toBe(false);
    expect(fetchImageNeedsConfirm({ url: 'not a url' }, '')).toBe(false);
  });
});
