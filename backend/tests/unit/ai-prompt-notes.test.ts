// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ai-prompt-notes.test.ts — Công tắc aiIncludeNotes phải thật sự chặn ghi chú
 * nội bộ rời máy chủ, không chỉ ẩn trên giao diện.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = {
  note: { findMany: vi.fn() },
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));

const { buildAiPromptContext } = await import('../../src/modules/ai/ai-service.ts');
const { buildVirtualChatUserPrompt } = await import(
  '../../src/modules/ai/ai-virtual-chat-service.ts'
);

const MESSAGES = [
  {
    senderType: 'contact',
    senderName: 'Chị Hoa',
    content: 'Căn 2PN còn không em?',
    sentAt: new Date('2026-08-25T02:00:00.000Z'),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.note.findMany.mockResolvedValue([
    {
      body: 'Khách này trả giá rát, còn hạ được 200tr',
      createdAt: new Date('2026-08-24T02:00:00.000Z'),
      author: { fullName: 'Sale A' },
    },
  ]);
});

describe('buildAiPromptContext (AI màn Chat)', () => {
  it('công tắc TẮT thì không đọc bảng ghi chú, prompt không có nội dung nội bộ', async () => {
    const prompt = await buildAiPromptContext({
      orgId: 'o1',
      includeNotes: false,
      contactId: 'c1',
      contactName: 'Chị Hoa',
      profileNote: 'Khách quen',
      messages: MESSAGES,
    });

    expect(prismaMock.note.findMany).not.toHaveBeenCalled();
    expect(prompt).not.toContain('internal_notes');
    expect(prompt).not.toContain('hạ được 200tr');
    expect(prompt).not.toContain('Khách quen');
    // Tin nhắn thì vẫn phải có như cũ.
    expect(prompt).toContain('Căn 2PN còn không em?');
  });

  it('công tắc BẬT thì ghi chú vào prompt cùng tin nhắn', async () => {
    const prompt = await buildAiPromptContext({
      orgId: 'o1',
      includeNotes: true,
      contactId: 'c1',
      contactName: 'Chị Hoa',
      profileNote: 'Khách quen',
      messages: MESSAGES,
    });

    expect(prompt).toContain('hạ được 200tr');
    expect(prompt).toContain('Khách quen');
    expect(prompt).toContain('Căn 2PN còn không em?');
  });

  it('ghi chú nằm NGOÀI thẻ conversation_context để AI không tưởng là lời khách', async () => {
    const prompt = await buildAiPromptContext({
      orgId: 'o1',
      includeNotes: true,
      contactId: 'c1',
      contactName: 'Chị Hoa',
      profileNote: null,
      messages: MESSAGES,
    });

    expect(prompt.indexOf('</internal_notes>')).toBeLessThan(
      prompt.indexOf('<conversation_context>'),
    );
  });

  it('bật công tắc nhưng khách chưa có ghi chú thì không chèn block trống', async () => {
    prismaMock.note.findMany.mockResolvedValue([]);

    const prompt = await buildAiPromptContext({
      orgId: 'o1',
      includeNotes: true,
      contactId: 'c1',
      contactName: 'Chị Hoa',
      profileNote: null,
      messages: MESSAGES,
    });

    expect(prompt).not.toContain('internal_notes');
  });
});

describe('rào chắn trong system prompt', () => {
  it('bản nháp trả lời khách bị cấm trích lại ghi chú nội bộ', async () => {
    const { buildReplyDraftPrompt } = await import('../../src/modules/ai/prompts/reply-draft.ts');

    for (const lang of ['vi', 'en'] as const) {
      const p = buildReplyDraftPrompt(lang);
      expect(p).toContain('internal_notes');
      expect(p.toLowerCase()).toContain('never quote');
    }
  });

  it('tóm tắt và cảm xúc được phép dùng ghi chú làm bối cảnh', async () => {
    const { buildSummaryPrompt } = await import('../../src/modules/ai/prompts/summary.ts');
    const { buildSentimentPrompt } = await import('../../src/modules/ai/prompts/sentiment.ts');

    expect(buildSummaryPrompt('vi')).toContain('internal_notes');
    expect(buildSentimentPrompt('vi')).toContain('internal_notes');
  });
});

describe('buildVirtualChatUserPrompt (trợ lý chat ảo)', () => {
  const CTX = {
    history: [{ role: 'sale' as const, content: 'Khách anh Nam 45 tuổi' }],
    contact: {
      fullName: 'Nam', phone: null, gender: null, birthYear: null,
      occupation: null, incomeRange: null, province: null, district: null, source: null,
    },
    latestSaleMessage: 'Khách anh Nam 45 tuổi',
  };

  it('không có ghi chú thì prompt giữ nguyên như cũ', () => {
    const prompt = buildVirtualChatUserPrompt({ ...CTX, noteBlock: '' });

    expect(prompt).not.toContain('internal_notes');
    expect(prompt).toContain('<contact_context>');
    expect(prompt).toContain('Khách anh Nam 45 tuổi');
  });

  it('có ghi chú thì chèn vào prompt', () => {
    const prompt = buildVirtualChatUserPrompt({
      ...CTX,
      noteBlock: '<internal_notes>\n[hồ sơ]: Khách quen\n</internal_notes>',
    });

    expect(prompt).toContain('Khách quen');
    expect(prompt).toContain('<contact_context>');
  });
});
