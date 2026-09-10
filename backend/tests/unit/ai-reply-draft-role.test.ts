// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ai-reply-draft-role.test.ts — AI soạn nháp phải đứng về phía NHÂN VIÊN.
 *
 * Bug 2026-09-10: sale gõ "đây có phải zalo của bạn Thảo không ạ", AI nháp lại
 * "Dạ đúng rồi ạ, em là Thảo..." — nó đóng vai KHÁCH trả lời. Vì prompt chỉ nói
 * "generate a reply draft" mà không giao vai, còn dòng cuối trong ngữ cảnh lại là
 * của staff → người trả lời tiếp theo, hiểu tự nhiên, chính là khách.
 */
import { describe, it, expect } from 'vitest';
import { buildReplyDraftPrompt } from '../../src/modules/ai/prompts/reply-draft.ts';

const LANGS = ['vi', 'en'] as const;

describe('buildReplyDraftPrompt — giao vai', () => {
  it('nói rõ đang soạn tin cho NHÂN VIÊN gửi đi', () => {
    for (const lang of LANGS) {
      const p = buildReplyDraftPrompt(lang).toLowerCase();
      // Phải nêu cả hai đầu: viết thay staff, gửi tới customer.
      expect(p, lang).toContain('staff');
      expect(p, lang).toContain('customer');
      expect(p, lang).toMatch(/on behalf of|as the staff|staff will send/);
    }
  });

  it('cấm tuyệt đối đóng vai khách hàng', () => {
    for (const lang of LANGS) {
      const p = buildReplyDraftPrompt(lang).toLowerCase();
      expect(p, lang).toMatch(/never (write|reply|respond) as the customer/);
    }
  });

  it('cấm nhập vai một cái tên nhắc trong hội thoại', () => {
    // Chính là chỗ AI vớ lấy "Thảo" làm danh tính của mình.
    for (const lang of LANGS) {
      expect(buildReplyDraftPrompt(lang).toLowerCase(), lang).toContain('impersonate');
    }
  });

  it('giải thích nhãn "staff" trong ngữ cảnh là dòng của chính mình', () => {
    for (const lang of LANGS) {
      const p = buildReplyDraftPrompt(lang).toLowerCase();
      expect(p, lang).toMatch(/labell?ed "?staff"?/);
    }
  });

  it('giữ nguyên các rào chắn cũ về ghi chú nội bộ', () => {
    for (const lang of LANGS) {
      const p = buildReplyDraftPrompt(lang);
      expect(p, lang).toContain('internal_notes');
      expect(p.toLowerCase(), lang).toContain('never quote');
    }
  });

  it('vẫn phân biệt ngôn ngữ đầu ra', () => {
    expect(buildReplyDraftPrompt('vi')).toContain('tieng Viet');
    expect(buildReplyDraftPrompt('en')).toContain('English');
  });
});
