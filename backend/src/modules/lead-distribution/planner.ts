// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * planner.ts — Toàn bộ luật chia lead. HÀM THUẦN, không chạm DB, không chạm Date.now().
 *
 * Mọi thứ cần biết đều truyền vào qua tham số (kể cả `now` và `rng`) nên test được
 * mà không cần DB — xem tests/unit/lead-distribution-planner.test.ts. executor.ts chỉ
 * ghi DB theo kế hoạch này và cố ý KHÔNG chứa nhánh quyết định nào.
 *
 * Spec: docs/superpowers/specs/2026-08-19-chia-lead-tu-dong-design.md
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Mốc "ngày VN" dùng vnDayRange() ở src/shared/utils/vn-time.ts — cron truyền
// assignedToday đã đếm sẵn vào đây, planner không tự tính mốc ngày.

export interface PlannerConfig {
  dailyQuotaPerUser: number;
  coAssignAfterDays: number;
  escalateAfterDays: number;
}

/** Một sale trong vòng chia. `dailyQuota` đã resolve xong (member ?? org). */
export interface SaleMember {
  userId: string;
  dailyQuota: number;
  /** Số khách chưa chốt user này đang ôm — dùng để cân tải. */
  activeLoad: number;
  /** Số lead vòng 1 đã nhận trong NGÀY VN hôm nay, đếm từ DB (không phải RAM). */
  assignedToday: number;
}

/** Lead chưa có chủ, đủ điều kiện vào vòng 1. */
export interface CandidateLead {
  contactId: string;
  createdAt: Date;
}

/** Một dòng LeadAssignment round 1 đang tồn tại, kèm trạng thái contact. */
export interface PrimaryAssignment {
  assignmentId: string;
  contactId: string;
  /** Sale đang là chủ chính. */
  userId: string;
  assignedAt: Date;
  escalatedAt: Date | null;
  /** Khách đã chốt/đã bỏ chưa — xem isContactClosed(). */
  closed: boolean;
  /** Đã có dòng round 2 chưa. */
  hasRound2: boolean;
  /** MỌI user đã có ContactAccess với khách này (kể cả dính qua Zalo/chat ảo). */
  accessUserIds: string[];
}

export interface PlannedAssignment {
  contactId: string;
  userId: string;
}

export interface Plan {
  round1: PlannedAssignment[];
  round2: PlannedAssignment[];
  /** Dòng round 1 cần gắn cờ báo admin. */
  escalate: Array<{ assignmentId: string; contactId: string }>;
}

/**
 * Khách "đã chốt" — KHÔNG thêm sale 2, KHÔNG gắn cờ quá hạn.
 *
 * Phải xét CẢ HAI nguồn: Status.isTerminal là chuẩn mới, nhưng Contact.status chuỗi
 * cũ vẫn được schema đánh dấu LEGACY chưa drop và có thể là thứ duy nhất org đang
 * dùng nếu họ chưa cấu hình bảng Status. Thiếu vế sau thì khách đã chốt vẫn bị
 * nhét thêm sale.
 */
export function isContactClosed(args: {
  statusIsTerminal?: boolean | null;
  legacyStatus?: string | null;
}): boolean {
  if (args.statusIsTerminal === true) return true;
  const s = (args.legacyStatus || '').toLowerCase();
  return s === 'converted' || s === 'lost';
}

/**
 * Hạn mức thực của một sale: hạn mức riêng đè mặc định org.
 *
 * Phân biệt `null` (chưa đặt riêng → theo org) với `0` (admin cố ý đặt 0 → không
 * nhận lead mới, nhưng vẫn giữ khách đang có). `?? ` làm đúng việc này, `||` thì
 * biến 0 thành mặc định org — đúng loại lỗi im lặng khó thấy khi đối soát.
 */
export function resolveQuota(memberQuota: number | null | undefined, orgDefault: number): number {
  return Math.max(0, memberQuota ?? orgDefault);
}

/** Đã qua `days` ngày kể từ `since` tính tới `now` chưa. */
function isOlderThanDays(since: Date, now: Date, days: number): boolean {
  return now.getTime() - since.getTime() >= days * DAY_MS;
}

/** Trạng thái tải chạy trong bộ nhớ suốt một lần chạy. */
interface LoadState {
  userId: string;
  load: number;
  /** Còn nhận thêm được mấy lead nữa hôm nay. */
  remaining: number;
}

/**
 * Chọn người nhận: tải thấp nhất trước. Hòa thì để `pickTie` quyết (vòng 1 lấy
 * người đầu cho ổn định/tái hiện được, vòng 2 bốc ngẫu nhiên theo yêu cầu khách).
 */
function pickLeastLoaded(
  pool: LoadState[],
  pickTie: (tied: LoadState[]) => LoadState,
): LoadState | null {
  const usable = pool.filter((m) => m.remaining > 0);
  if (usable.length === 0) return null;
  const min = Math.min(...usable.map((m) => m.load));
  const tied = usable.filter((m) => m.load === min);
  return tied.length === 1 ? tied[0] : pickTie(tied);
}

/**
 * VÒNG 1 — chia lead chưa có chủ.
 *
 * Lead cũ trước (FIFO theo createdAt) để không có lead nào nằm mãi dưới đáy.
 * Người nhận luôn là người đang ôm ít nhất: khi tải bằng nhau thì hành vi đúng
 * bằng round-robin, còn khi lead không đủ chia đều thì phần dư KHÔNG rơi vào
 * cùng một người mỗi ngày như cách xoay theo thứ tự cố định.
 */
export function planRound1(leads: CandidateLead[], members: SaleMember[]): PlannedAssignment[] {
  const pool: LoadState[] = members.map((m) => ({
    userId: m.userId,
    load: m.activeLoad,
    remaining: Math.max(0, m.dailyQuota - m.assignedToday),
  }));

  const sorted = [...leads].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.contactId.localeCompare(b.contactId),
  );

  const out: PlannedAssignment[] = [];
  for (const lead of sorted) {
    // Hòa ở vòng 1 lấy userId nhỏ nhất — kết quả tái hiện được khi đối soát.
    const chosen = pickLeastLoaded(pool, (tied) =>
      [...tied].sort((a, b) => a.userId.localeCompare(b.userId))[0],
    );
    if (!chosen) break; // mọi người đã đầy hạn mức
    out.push({ contactId: lead.contactId, userId: chosen.userId });
    chosen.load++;
    chosen.remaining--;
  }
  return out;
}

/**
 * VÒNG 2 — thêm sale thứ 2 vào chăm cùng.
 *
 * Loại MỌI user đã có ContactAccess với khách đó, không riêng người primary: sale
 * khác có thể đã dính vào qua kết bạn Zalo hoặc chat ảo, thêm người đã ở sẵn thì
 * sinh ra dòng round 2 mà chẳng mở thêm quyền cho ai.
 *
 * Có áp hạn mức ngày cho vòng 2, khác với thiết kế ban đầu. Lý do: bình thường
 * nhịp vào của vòng 2 tự bằng nhịp vòng 1 nên không cần chặn, NHƯNG sau khi admin
 * bấm "nạp tồn" thì cả 1844 contact có cùng assignedAt, tới ngày thứ 14 sẽ đáo hạn
 * cùng lúc và dội ~184 khách vào mỗi sale trong một buổi sáng. Có trần thì phần
 * dư tự chảy sang các ngày sau vì chúng vẫn quá hạn, không mất đi đâu.
 */
export function planRound2(
  primaries: PrimaryAssignment[],
  members: SaleMember[],
  config: PlannerConfig,
  now: Date,
  rng: () => number = Math.random,
): PlannedAssignment[] {
  const pool: LoadState[] = members.map((m) => ({
    userId: m.userId,
    load: m.activeLoad,
    remaining: Math.max(0, m.dailyQuota),
  }));

  const due = primaries
    .filter((p) => !p.closed && !p.hasRound2 && isOlderThanDays(p.assignedAt, now, config.coAssignAfterDays))
    .sort((a, b) => a.assignedAt.getTime() - b.assignedAt.getTime() || a.contactId.localeCompare(b.contactId));

  const out: PlannedAssignment[] = [];
  for (const p of due) {
    const taken = new Set(p.accessUserIds);
    taken.add(p.userId); // phòng khi ContactAccess chưa kịp đồng bộ
    const candidates = pool.filter((m) => !taken.has(m.userId));
    // Hòa ở vòng 2 bốc ngẫu nhiên — đúng yêu cầu "pick random" của khách.
    const chosen = pickLeastLoaded(candidates, (tied) => tied[Math.floor(rng() * tied.length)]);
    if (!chosen) continue; // không còn ai để thêm (org 1 sale, hoặc mọi người đã đầy) — bỏ qua im lặng
    out.push({ contactId: p.contactId, userId: chosen.userId });
    chosen.load++;
    chosen.remaining--;
  }
  return out;
}

/**
 * VIỆC 3 — gắn cờ khách quá hạn để admin tự quyết. Không thêm sale 3, không rút
 * quyền của ai. `escalatedAt` đã có thì bỏ qua, nên chạy lại bao nhiêu lần cũng
 * không báo lặp.
 */
export function planEscalations(
  primaries: PrimaryAssignment[],
  config: PlannerConfig,
  now: Date,
): Array<{ assignmentId: string; contactId: string }> {
  return primaries
    .filter(
      (p) =>
        !p.closed &&
        p.escalatedAt === null &&
        isOlderThanDays(p.assignedAt, now, config.escalateAfterDays),
    )
    .map((p) => ({ assignmentId: p.assignmentId, contactId: p.contactId }));
}

export function buildPlan(input: {
  leads: CandidateLead[];
  primaries: PrimaryAssignment[];
  members: SaleMember[];
  config: PlannerConfig;
  now: Date;
  rng?: () => number;
}): Plan {
  const round1 = planRound1(input.leads, input.members);

  // Vòng 2 phải thấy tải mà vòng 1 vừa tạo ra trong CHÍNH lần chạy này. Nếu dùng
  // lại ảnh chụp tải ban đầu thì sale vừa nhận 12 lead mới vẫn bị coi là rảnh và
  // lãnh tiếp phần chăm-cùng — cân tải hỏng ngay trong một lần chạy.
  const round1Count = new Map<string, number>();
  for (const a of round1) round1Count.set(a.userId, (round1Count.get(a.userId) ?? 0) + 1);
  const membersAfterRound1 = input.members.map((m) => ({
    ...m,
    activeLoad: m.activeLoad + (round1Count.get(m.userId) ?? 0),
  }));

  return {
    round1,
    round2: planRound2(input.primaries, membersAfterRound1, input.config, input.now, input.rng),
    escalate: planEscalations(input.primaries, input.config, input.now),
  };
}
