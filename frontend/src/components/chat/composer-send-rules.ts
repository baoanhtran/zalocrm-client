// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * composer-send-rules.ts — Quyết định ô soạn chat gửi CÁI GÌ, ĐƯỜNG NÀO.
 *
 * Bug 2026-09-04 (người dùng web báo "gửi ảnh bị chia làm 2 tin nhắn"): trước đây
 * chọn/paste/kéo-thả ảnh là POST /attachments NGAY, chữ đang gõ ở lại ô soạn nên phải
 * Enter lần nữa → khách nhận 2 tin. Giờ đính kèm vào khay chờ, bấm Gửi mới đi, và chữ
 * đi kèm dưới dạng `caption` trong CÙNG request.
 *
 * Tách khỏi MessageThread.vue để test được không cần mount component — cùng lối với
 * slash-popup-rules.ts.
 */

export type AttachmentKind = 'image' | 'video' | 'file';

export interface PendingAttachment {
  kind: AttachmentKind;
}

export type ComposerSendPlan =
  /** Không có gì để gửi. */
  | { action: 'none' }
  /** Đang sửa tin cũ — chỉ đổi chữ, khay đính kèm để nguyên. */
  | { action: 'edit' }
  /** Chỉ có chữ → đường gửi tin nhắn cũ. */
  | { action: 'text' }
  /** Có đính kèm → POST /attachments, chữ đi kèm làm caption. */
  | { action: 'attachments'; caption: string };

export function planComposerSend(input: {
  text: string;
  pending: PendingAttachment[];
  isEditing: boolean;
}): ComposerSendPlan {
  const text = input.text.trim();

  // Sửa tin là thao tác thuần chữ — Zalo không cho thay đính kèm của tin đã gửi.
  // Sửa thành rỗng thì không gửi gì (giữ đúng hành vi cũ của ô soạn).
  if (input.isEditing) return text ? { action: 'edit' } : { action: 'none' };

  if (input.pending.length > 0) return { action: 'attachments', caption: text };
  if (text) return { action: 'text' };
  return { action: 'none' };
}

/**
 * Nút Gửi có bật không. Khác bản cũ ở chỗ: khay có đính kèm thì bật kể cả chưa gõ chữ
 * (không thì không gửi được ảnh trần).
 */
export function canSubmitComposer(text: string, pending: PendingAttachment[]): boolean {
  return pending.length > 0 || text.trim().length > 0;
}
