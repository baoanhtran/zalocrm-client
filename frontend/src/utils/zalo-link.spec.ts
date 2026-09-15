// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { realZaloUid, pickConversationForContact, resolveNickForContact } from './zalo-link';

describe('realZaloUid', () => {
  it('chat nội bộ → null (mã virtual: không phải UID Zalo)', () => {
    expect(realZaloUid({ id: 'v', threadType: 'user', isVirtual: true, externalThreadId: 'virtual:c:n' })).toBeNull();
  });
  it('externalThreadId dạng virtual: dù thiếu cờ isVirtual → vẫn null', () => {
    expect(realZaloUid({ id: 'v', threadType: 'user', externalThreadId: 'virtual:c:n' })).toBeNull();
  });
  it('chat nội bộ KHÔNG rơi về contact.zaloUid (UID của nick khác)', () => {
    expect(realZaloUid({
      id: 'v', threadType: 'user', isVirtual: true, externalThreadId: 'virtual:c:n', contact: { zaloUid: 'uid-other' },
    })).toBeNull();
  });
  it('nhóm → null', () => {
    expect(realZaloUid({ id: 'g', threadType: 'group', externalThreadId: 'group-1' })).toBeNull();
  });
  it('chat Zalo → UID theo nick', () => {
    expect(realZaloUid({ id: 'r', threadType: 'user', externalThreadId: 'uid-1' })).toBe('uid-1');
  });
  it('chat Zalo thiếu externalThreadId → contact.zaloUid như cũ', () => {
    expect(realZaloUid({ id: 'r', threadType: 'user', externalThreadId: null, contact: { zaloUid: 'uid-2' } })).toBe('uid-2');
  });
});

describe('pickConversationForContact', () => {
  const virtual = { id: 'v', threadType: 'user', isVirtual: true, contact: { id: 'c1' } };
  const real = { id: 'r', threadType: 'user', isVirtual: false, contact: { id: 'c1' } };
  const group = { id: 'g', threadType: 'group', contact: { id: 'c1' } };

  it('có cả chat nội bộ lẫn chat Zalo → chọn chat Zalo dù chat nội bộ đứng trước', () => {
    expect(pickConversationForContact([virtual, real], 'c1')?.id).toBe('r');
  });
  it('chỉ có chat nội bộ → chọn chat nội bộ', () => {
    expect(pickConversationForContact([group, virtual], 'c1')?.id).toBe('v');
  });
  it('không có hội thoại của KH → null', () => {
    expect(pickConversationForContact([real], 'c2')).toBeNull();
  });
});

describe('resolveNickForContact', () => {
  const hien = { id: 'hien', status: 'connected', ownerUserId: 'u-hien' }; // nick tạo sớm nhất
  const maiHoa = { id: 'maihoa', status: 'connected', ownerUserId: 'u-dung' };
  const linhOff = { id: 'linh', status: 'disconnected', ownerUserId: 'u-phuong' };

  it('dùng nick của sale phụ trách, KHÔNG lấy nick tạo sớm nhất (lỗi: mọi khách rơi vào nick Hien)', () => {
    expect(resolveNickForContact([hien, maiHoa], 'u-dung')).toEqual({ nick: maiHoa });
  });
  it('khách chưa có sale phụ trách → cho chọn trong các nick đang kết nối', () => {
    expect(resolveNickForContact([hien, maiHoa, linhOff], null)).toEqual({ choices: [hien, maiHoa], reason: 'no_sale' });
  });
  it('nick của sale phụ trách mất kết nối → cho chọn nick khác đang kết nối', () => {
    expect(resolveNickForContact([hien, linhOff], 'u-phuong')).toEqual({ choices: [hien], reason: 'sale_no_nick' });
  });
  it('sale phụ trách có nhiều nick đang kết nối → chỉ cho chọn giữa các nick đó', () => {
    const maiHoa2 = { id: 'maihoa2', status: 'connected', ownerUserId: 'u-dung' };
    expect(resolveNickForContact([hien, maiHoa, maiHoa2], 'u-dung')).toEqual({ choices: [maiHoa, maiHoa2], reason: 'sale_many_nicks' });
  });
  it('không nick nào kết nối → danh sách chọn rỗng', () => {
    expect(resolveNickForContact([linhOff], 'u-phuong')).toEqual({ choices: [], reason: 'sale_no_nick' });
  });
});
