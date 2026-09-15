/**
 * virtual-chat-nick.test.ts — chat nội bộ nằm trên nick nào.
 *
 * Trước đây: nick người bấm sở hữu → nick ĐẦU TIÊN truy cập được. Admin không sở hữu nick nên
 * chat nội bộ rơi vào nick bất kỳ (thực tế: nick Trà My chứa chat của khách thuộc sale Linh,
 * Mai Hoa) → sale khác thấy khách không phải của mình, "Kết bạn" gửi từ nhầm nick.
 */
import { describe, it, expect } from 'vitest';
import { pickVirtualChatNick } from '../src/modules/contacts/virtual-chat-nick.js';

describe('pickVirtualChatNick', () => {
  const accessible = ['hien', 'tramy', 'maihoa'];

  it('admin (không sở hữu nick) → nick của sale phụ trách, không lấy nick đầu tiên', () => {
    expect(pickVirtualChatNick(accessible, new Set(), ['maihoa'])).toBe('maihoa');
  });
  it('nick sale phụ trách đứng trước nick người bấm sở hữu', () => {
    expect(pickVirtualChatNick(accessible, new Set(['tramy']), ['maihoa'])).toBe('maihoa');
  });
  it('nick sale phụ trách ngoài phạm vi người bấm → nick người bấm sở hữu', () => {
    expect(pickVirtualChatNick(['tramy'], new Set(['tramy']), ['maihoa'])).toBe('tramy');
  });
  it('khách chưa có sale phụ trách → nick người bấm sở hữu', () => {
    expect(pickVirtualChatNick(accessible, new Set(['tramy']), [])).toBe('tramy');
  });
  it('không có sale, người bấm không sở hữu nick → nick đầu tiên truy cập được', () => {
    expect(pickVirtualChatNick(accessible, new Set(), [])).toBe('hien');
  });
  it('không truy cập được nick nào → null', () => {
    expect(pickVirtualChatNick([], new Set(), ['maihoa'])).toBeNull();
  });
});
