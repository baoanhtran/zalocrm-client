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

/**
 * Nick dùng để tra SĐT: nick chỉ định (nếu đang kết nối) → nick của chính mình → nick được cấp quyền.
 * Nick mất kết nối tra là lỗi NOT_CONNECTED nên bỏ qua.
 */
export function pickLookupNick<T extends NickLike>(
  nicks: T[],
  myUserId: string | null | undefined,
  preferredId?: string | null,
): T | null {
  const live = nicks.filter((n) => n.status === 'connected');
  return (
    live.find((n) => n.id === preferredId)
    ?? live.find((n) => n.ownerUserId === myUserId)
    ?? live[0]
    ?? null
  );
}
