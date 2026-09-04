import { describe, it, expect } from 'vitest';
import { planComposerSend, canSubmitComposer } from './composer-send-rules';

const img = { kind: 'image' as const };
const file = { kind: 'file' as const };

describe('planComposerSend', () => {
  it('gửi chữ theo đường cũ khi khay đính kèm rỗng', () => {
    expect(planComposerSend({ text: 'chào anh', pending: [], isEditing: false }))
      .toEqual({ action: 'text' });
  });

  it('gộp chữ vào đính kèm thành MỘT lần gửi khi khay có đồ', () => {
    expect(planComposerSend({ text: 'bảng giá tháng 9', pending: [img], isEditing: false }))
      .toEqual({ action: 'attachments', caption: 'bảng giá tháng 9' });
  });

  it('gửi được đính kèm trần khi không gõ chữ', () => {
    expect(planComposerSend({ text: '', pending: [img, file], isEditing: false }))
      .toEqual({ action: 'attachments', caption: '' });
  });

  it('cắt khoảng trắng thừa của caption', () => {
    expect(planComposerSend({ text: '  xin chào  ', pending: [img], isEditing: false }))
      .toEqual({ action: 'attachments', caption: 'xin chào' });
  });

  it('không gửi gì khi cả chữ lẫn khay đều rỗng', () => {
    expect(planComposerSend({ text: '   ', pending: [], isEditing: false }))
      .toEqual({ action: 'none' });
  });

  it('đang sửa tin thì chỉ sửa chữ, không đụng khay đính kèm', () => {
    expect(planComposerSend({ text: 'sửa lại', pending: [img], isEditing: true }))
      .toEqual({ action: 'edit' });
  });

  it('không sửa tin thành chữ rỗng', () => {
    expect(planComposerSend({ text: '  ', pending: [], isEditing: true }))
      .toEqual({ action: 'none' });
  });
});

describe('canSubmitComposer', () => {
  it('bật nút Gửi khi có chữ', () => {
    expect(canSubmitComposer('chào', [])).toBe(true);
  });

  it('bật nút Gửi khi khay có đính kèm dù chưa gõ chữ', () => {
    expect(canSubmitComposer('', [img])).toBe(true);
  });

  it('tắt nút Gửi khi chỉ có khoảng trắng và khay rỗng', () => {
    expect(canSubmitComposer('   ', [])).toBe(false);
  });
});
