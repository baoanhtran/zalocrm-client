// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * gemini-thinking-config.test.ts — Chọn tham số suy luận theo ĐỜI model Gemini.
 *
 * 2.5 dùng thinkingBudget, 3.x trở lên dùng thinkingLevel. Gửi cả hai trong cùng
 * một request là Gemini báo lỗi, nên hai nhánh phải loại trừ nhau tuyệt đối.
 */
import { describe, it, expect } from 'vitest';
import { buildGeminiGenerationConfig } from '../../src/modules/ai/providers/gemini.ts';

type Cfg = {
  temperature: number;
  maxOutputTokens: number;
  thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
};

const cfg = (model: string, maxTokens = 600) =>
  buildGeminiGenerationConfig(model, maxTokens) as Cfg;

describe('buildGeminiGenerationConfig', () => {
  it('đời 3.x dùng thinkingLevel MINIMAL', () => {
    expect(cfg('gemini-3.6-flash').thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  it('mọi đời 3.x khác cũng vậy, không chỉ 3.6', () => {
    for (const m of ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.0-pro']) {
      expect(cfg(m).thinkingConfig, m).toEqual({ thinkingLevel: 'MINIMAL' });
    }
  });

  it('đời sau 3 (4.x) vẫn đi nhánh thinkingLevel, không rơi về mặc định', () => {
    // Chốt chặn cho lần Google ra đời mới — bug cũ chính là regex chỉ khớp đúng 2.5.
    expect(cfg('gemini-4.0-flash').thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  it('2.5 giữ nguyên thinkingBudget 0 như cũ', () => {
    expect(cfg('gemini-2.5-flash').thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('2.0 không suy luận nên không gửi thinkingConfig', () => {
    expect(cfg('gemini-2.0-flash').thinkingConfig).toBeUndefined();
  });

  it('KHÔNG BAO GIỜ gửi đồng thời thinkingBudget và thinkingLevel', () => {
    for (const m of ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest']) {
      const tc = cfg(m).thinkingConfig;
      if (!tc) continue;
      const both = tc.thinkingBudget !== undefined && tc.thinkingLevel !== undefined;
      expect(both, `${m} gửi cả hai → Gemini trả lỗi`).toBe(false);
    }
  });

  it('đời 3.x được nới trần token vì MINIMAL vẫn tốn token suy luận', () => {
    expect(cfg('gemini-3.6-flash', 600).maxOutputTokens).toBe(3000);
  });

  it('caller xin nhiều hơn mức sàn thì tôn trọng caller', () => {
    expect(cfg('gemini-3.6-flash', 8000).maxOutputTokens).toBe(8000);
  });

  it('model không suy luận thì giữ nguyên trần của caller', () => {
    expect(cfg('gemini-2.5-flash', 600).maxOutputTokens).toBe(600);
    expect(cfg('gemini-2.0-flash', 600).maxOutputTokens).toBe(600);
  });

  it('tên model lạ không làm hàm nổ', () => {
    for (const m of ['gemini-flash-latest', '', 'models/gemini-3.6-flash']) {
      expect(() => cfg(m), m).not.toThrow();
    }
  });
});
