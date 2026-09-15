// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * zalo-link.ts — phân biệt chat Zalo thật với chat nội bộ (isVirtual) + chọn nick để tra SĐT.
 *
 * Chat nội bộ có externalThreadId giả `virtual:<contact>:<nick>`. Đưa mã đó cho Zalo (kết bạn,
 * trạng thái bạn bè) là nhận zalo:114 "Tham số không hợp lệ" → mọi chỗ cần UID Zalo đi qua realZaloUid().
 */

export interface ConvLike {
  id: string;
  threadType: string;
  isVirtual?: boolean;
  externalThreadId?: string | null;
  contact?: { id?: string; zaloUid?: string | null } | null;
}

export interface NickLike {
  id: string;
  status: string;
  ownerUserId: string;
}

const VIRTUAL_THREAD_PREFIX = 'virtual:';

export function isVirtualConversation(conv: ConvLike | null | undefined): boolean {
  if (!conv) return false;
  return conv.isVirtual === true || (conv.externalThreadId ?? '').startsWith(VIRTUAL_THREAD_PREFIX);
}

/** UID Zalo của KH theo nick của hội thoại; null với nhóm và chat nội bộ. */
export function realZaloUid(conv: ConvLike | null | undefined): string | null {
  if (!conv || conv.threadType !== 'user' || isVirtualConversation(conv)) return null;
  return conv.externalThreadId || conv.contact?.zaloUid || null;
}

/** KH có cả chat Zalo lẫn chat nội bộ → "Mở chat" phải ra chat Zalo; chỉ có chat nội bộ thì mở nó. */
export function pickConversationForContact<T extends ConvLike>(convs: T[], contactId: string): T | null {
  const mine = convs.filter((c) => c.contact?.id === contactId && c.threadType === 'user');
  return mine.find((c) => !isVirtualConversation(c)) ?? mine[0] ?? null;
}

export type NickResolution<T> =
  | { nick: T }
  | { choices: T[]; reason: 'no_sale' | 'sale_no_nick' | 'sale_many_nicks' };

/**
 * Nick để tra SĐT / gửi lời mời cho KH = nick của sale phụ trách (user chốt 2026-09-15). Trước đó lấy
 * "nick đầu tiên" nên admin (không sở hữu nick) bấm khách nào cũng rơi vào nick tạo sớm nhất.
 * Sale phụ trách có đúng 1 nick đang kết nối → dùng luôn; còn lại → trả danh sách để người bấm chọn.
 * Nick mất kết nối tra là lỗi NOT_CONNECTED nên không đưa vào.
 */
export function resolveNickForContact<T extends NickLike>(
  nicks: T[],
  assignedUserId: string | null | undefined,
): NickResolution<T> {
  const live = nicks.filter((n) => n.status === 'connected');
  if (!assignedUserId) return { choices: live, reason: 'no_sale' };
  const saleNicks = live.filter((n) => n.ownerUserId === assignedUserId);
  if (saleNicks.length === 1) return { nick: saleNicks[0] };
  if (saleNicks.length > 1) return { choices: saleNicks, reason: 'sale_many_nicks' };
  return { choices: live, reason: 'sale_no_nick' };
}
