/**
 * virtual-chat-welcome.test.ts — lời chào đầu tiên của chat nội bộ.
 *
 * Chat nội bộ giờ mở được cho cả KH đã có Zalo → lời chào không được khẳng định "KH chưa có
 * Zalo", và phải hợp nghiệp vụ du học/XKLĐ (bản cũ còn sót ví dụ bất động sản).
 */
import { describe, it, expect } from 'vitest';
import { buildVirtualChatWelcome } from '../src/modules/contacts/virtual-chat-welcome.js';

describe('buildVirtualChatWelcome', () => {
  it('ghi tên + SĐT KH và nói rõ tin không gửi đi Zalo', () => {
    const text = buildVirtualChatWelcome('Mai Hoàng Cậy', '0328648776');
    expect(text).toContain('Mai Hoàng Cậy');
    expect(text).toContain('0328648776');
    expect(text).toContain('KHÔNG gửi đi Zalo');
  });

  it('không khẳng định KH chưa có Zalo, không còn ví dụ bất động sản', () => {
    const text = buildVirtualChatWelcome('An', '0900000000');
    expect(text).not.toMatch(/chưa có Zalo/i);
    expect(text).not.toMatch(/muốn mua|ngân sách/i);
  });

  it('thiếu SĐT → ghi "chưa có SĐT"', () => {
    expect(buildVirtualChatWelcome('An', null)).toContain('chưa có SĐT');
  });
});
