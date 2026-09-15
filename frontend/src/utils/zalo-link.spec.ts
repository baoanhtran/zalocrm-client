// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { realZaloUid, pickConversationForContact, pickLookupNick } from './zalo-link';

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

describe('pickLookupNick', () => {
  const mineOff = { id: 'n1', status: 'disconnected', ownerUserId: 'me' };
  const mineOn = { id: 'n2', status: 'connected', ownerUserId: 'me' };
  const otherOn = { id: 'n3', status: 'connected', ownerUserId: 'boss' };

  it('nick chỉ định đang kết nối → dùng nick đó', () => {
    expect(pickLookupNick([mineOn, otherOn], 'me', 'n3')?.id).toBe('n3');
  });
  it('nick chỉ định mất kết nối → ưu tiên nick của mình đang kết nối', () => {
    expect(pickLookupNick([otherOn, mineOff, mineOn], 'me', 'n1')?.id).toBe('n2');
  });
  it('không có nick của mình → nick được cấp quyền đang kết nối', () => {
    expect(pickLookupNick([mineOff, otherOn], 'me')?.id).toBe('n3');
  });
  it('không nick nào kết nối → null', () => {
    expect(pickLookupNick([mineOff], 'me')).toBeNull();
  });
});
