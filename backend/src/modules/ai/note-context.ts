// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * note-context.ts — Dựng block <internal_notes> cho prompt AI.
 *
 * Ghi chú là bình luận NỘI BỘ của nhân viên (khách không bao giờ thấy) nên chỉ
 * được gửi ra provider khi org bật AiConfig.aiIncludeNotes. Caller lo công tắc,
 * file này lo lấy đúng dữ liệu + cắt + escape.
 *
 * Lấy phẳng cả note gốc lẫn reply (không lọc parentNoteId): với AI thì reply của
 * quản lý cũng là bối cảnh, thứ tự thời gian đủ để hiểu.
 */
import { prisma } from '../../shared/database/prisma-client.js';

/** Số ghi chú gần nhất đưa vào prompt. */
export const NOTE_LIMIT = 15;
/** Cắt mỗi ghi chú ở đây để 1 note dài không nuốt hết context window. */
export const NOTE_MAX_CHARS = 500;

/** Vô hiệu hoá tag ranh giới nhét trong nội dung — chống prompt injection. */
function stripBoundary(text: string): string {
  return text.replace(/<\/?internal_notes>/gi, '');
}

function clamp(text: string): string {
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS)}…` : text;
}

function line(text: string, prefix: string): string {
  return `${prefix}: ${clamp(stripBoundary(text).trim())}`;
}

/**
 * Trả về block `<internal_notes>...</internal_notes>`, hoặc chuỗi rỗng nếu khách
 * này không có ghi chú nào (không dựng block trống — tốn token, AI dễ bịa).
 */
export async function buildNoteContext(input: {
  orgId: string;
  contactId: string | null | undefined;
  /** Contact.notes — ô ghi chú tự do trên hồ sơ, caller đã load sẵn. */
  profileNote?: string | null;
}): Promise<string> {
  if (!input.contactId) return '';

  const notes = await prisma.note.findMany({
    where: { orgId: input.orgId, contactId: input.contactId },
    orderBy: { createdAt: 'desc' },
    take: NOTE_LIMIT,
    select: { body: true, createdAt: true, author: { select: { fullName: true } } },
  });

  const rows: string[] = [];

  const profile = stripBoundary(input.profileNote ?? '').trim();
  if (profile) rows.push(line(profile, '[hồ sơ]'));

  // DB trả mới → cũ (để take đúng N gần nhất); đảo lại cho AI đọc theo dòng thời gian.
  for (const n of [...notes].reverse()) {
    const body = stripBoundary(n.body ?? '').trim();
    if (!body) continue;
    const author = n.author?.fullName?.trim() || 'nhân viên';
    rows.push(line(body, `[${n.createdAt.toISOString()}] ${author}`));
  }

  if (rows.length === 0) return '';
  return ['<internal_notes>', ...rows, '</internal_notes>'].join('\n');
}
