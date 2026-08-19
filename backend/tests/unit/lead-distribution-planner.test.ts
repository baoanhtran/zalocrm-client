// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit test cho luật chia lead (hàm thuần, không DB).
import { describe, it, expect } from 'vitest';
import {
  planRound1,
  planRound2,
  planEscalations,
  buildPlan,
  isContactClosed,
  resolveQuota,
  type SaleMember,
  type CandidateLead,
  type PrimaryAssignment,
  type PlannerConfig,
} from '../../src/modules/lead-distribution/planner.js';

const CFG: PlannerConfig = { dailyQuotaPerUser: 12, coAssignAfterDays: 14, escalateAfterDays: 28 };
const NOW = new Date('2026-08-19T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function sale(userId: string, over: Partial<SaleMember> = {}): SaleMember {
  return { userId, dailyQuota: 12, activeLoad: 0, assignedToday: 0, ...over };
}
function leads(n: number, from = 0): CandidateLead[] {
  return Array.from({ length: n }, (_, i) => ({
    contactId: `c${String(from + i).padStart(3, '0')}`,
    createdAt: new Date(NOW.getTime() - (n - i) * 60_000),
  }));
}
function primary(over: Partial<PrimaryAssignment> = {}): PrimaryAssignment {
  return {
    assignmentId: 'a1',
    contactId: 'c1',
    userId: 'u1',
    assignedAt: daysAgo(20),
    escalatedAt: null,
    closed: false,
    hasRound2: false,
    accessUserIds: ['u1'],
    ...over,
  };
}

describe('resolveQuota', () => {
  it('hạn mức riêng đè mặc định org', () => {
    expect(resolveQuota(5, 12)).toBe(5);
  });
  it('null/undefined thì theo org', () => {
    expect(resolveQuota(null, 12)).toBe(12);
    expect(resolveQuota(undefined, 12)).toBe(12);
  });
  it('0 là 0 thật, KHÔNG rơi về mặc định org', () => {
    expect(resolveQuota(0, 12)).toBe(0);
  });
  it('số âm bị kẹp về 0', () => {
    expect(resolveQuota(-3, 12)).toBe(0);
  });
});

describe('isContactClosed', () => {
  it('chốt theo Status.isTerminal', () => {
    expect(isContactClosed({ statusIsTerminal: true })).toBe(true);
  });
  it('chốt theo status chuỗi legacy (converted/lost)', () => {
    expect(isContactClosed({ legacyStatus: 'converted' })).toBe(true);
    expect(isContactClosed({ legacyStatus: 'LOST' })).toBe(true);
  });
  it('chưa chốt', () => {
    expect(isContactClosed({ statusIsTerminal: false, legacyStatus: 'new' })).toBe(false);
    expect(isContactClosed({})).toBe(false);
    expect(isContactClosed({ statusIsTerminal: null, legacyStatus: null })).toBe(false);
  });
});

describe('planRound1', () => {
  it('chia đều cho các sale khi tải bằng nhau', () => {
    const out = planRound1(leads(6), [sale('u1'), sale('u2'), sale('u3')]);
    const per = new Map<string, number>();
    for (const a of out) per.set(a.userId, (per.get(a.userId) ?? 0) + 1);
    expect(out).toHaveLength(6);
    expect([...per.values()]).toEqual([2, 2, 2]);
  });

  it('dừng đúng khi mọi người đầy hạn mức, lead dư để lại cho hôm sau', () => {
    const out = planRound1(leads(50), [sale('u1', { dailyQuota: 2 }), sale('u2', { dailyQuota: 3 })]);
    expect(out).toHaveLength(5);
    expect(out.filter((a) => a.userId === 'u1')).toHaveLength(2);
    expect(out.filter((a) => a.userId === 'u2')).toHaveLength(3);
  });

  it('sale đã nhận đủ hạn mức hôm nay thì không nhận thêm (cron chạy lại không chia gấp đôi)', () => {
    const out = planRound1(leads(10), [
      sale('u1', { dailyQuota: 12, assignedToday: 12 }),
      sale('u2', { dailyQuota: 12, assignedToday: 10 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.userId === 'u2')).toBe(true);
  });

  it('hạn mức 0 thì không nhận lead nào', () => {
    const out = planRound1(leads(5), [sale('u1', { dailyQuota: 0 }), sale('u2')]);
    expect(out.every((a) => a.userId === 'u2')).toBe(true);
  });

  it('ưu tiên người đang ôm ít khách nhất', () => {
    const out = planRound1(leads(3), [sale('u1', { activeLoad: 50 }), sale('u2', { activeLoad: 0 })]);
    // u2 nhận 2 lead đầu để đuổi kịp, rồi mới tới lượt u1 khi hoà ở mức 50... không kịp,
    // nên cả 3 đều về u2.
    expect(out.map((a) => a.userId)).toEqual(['u2', 'u2', 'u2']);
  });

  it('lead cũ được chia trước (FIFO), không để lead nằm mãi dưới đáy', () => {
    const old = { contactId: 'cu', createdAt: new Date('2026-01-01T00:00:00Z') };
    const fresh = { contactId: 'cmoi', createdAt: new Date('2026-08-18T00:00:00Z') };
    const out = planRound1([fresh, old], [sale('u1', { dailyQuota: 1 })]);
    expect(out).toEqual([{ contactId: 'cu', userId: 'u1' }]);
  });

  it('không có sale nào thì trả rỗng, không nổ', () => {
    expect(planRound1(leads(5), [])).toEqual([]);
  });

  it('không có lead nào thì trả rỗng', () => {
    expect(planRound1([], [sale('u1')])).toEqual([]);
  });
});

describe('planRound2', () => {
  it('thêm sale 2 cho khách quá hạn, chưa chốt', () => {
    const out = planRound2([primary()], [sale('u1'), sale('u2')], CFG, NOW);
    expect(out).toEqual([{ contactId: 'c1', userId: 'u2' }]);
  });

  it('chưa tới hạn thì chưa đụng tới', () => {
    const out = planRound2([primary({ assignedAt: daysAgo(13) })], [sale('u1'), sale('u2')], CFG, NOW);
    expect(out).toEqual([]);
  });

  it('đúng mốc 14 ngày là tới hạn', () => {
    const out = planRound2([primary({ assignedAt: daysAgo(14) })], [sale('u1'), sale('u2')], CFG, NOW);
    expect(out).toHaveLength(1);
  });

  it('khách đã chốt thì không thêm sale 2', () => {
    expect(planRound2([primary({ closed: true })], [sale('u1'), sale('u2')], CFG, NOW)).toEqual([]);
  });

  it('khách đã có sale 2 rồi thì không thêm nữa (không có vòng 3)', () => {
    expect(planRound2([primary({ hasRound2: true })], [sale('u1'), sale('u2')], CFG, NOW)).toEqual([]);
  });

  it('org chỉ có 1 sale thì bỏ qua im lặng, không nổ', () => {
    expect(planRound2([primary()], [sale('u1')], CFG, NOW)).toEqual([]);
  });

  it('không bao giờ chọn người đã có ContactAccess với khách đó', () => {
    // u2 đã dính vào khách qua kết bạn Zalo → phải chọn u3
    const p = primary({ accessUserIds: ['u1', 'u2'] });
    const out = planRound2([p], [sale('u1'), sale('u2'), sale('u3')], CFG, NOW);
    expect(out).toEqual([{ contactId: 'c1', userId: 'u3' }]);
  });

  it('mọi ứng viên đều đã có quyền → bỏ qua, không tạo dòng thừa', () => {
    const p = primary({ accessUserIds: ['u1', 'u2'] });
    expect(planRound2([p], [sale('u1'), sale('u2')], CFG, NOW)).toEqual([]);
  });

  it('chọn người đang ôm ít khách nhất', () => {
    const out = planRound2(
      [primary()],
      [sale('u1'), sale('u2', { activeLoad: 90 }), sale('u3', { activeLoad: 3 })],
      CFG, NOW,
    );
    expect(out).toEqual([{ contactId: 'c1', userId: 'u3' }]);
  });

  it('hoà tải thì bốc ngẫu nhiên, kết quả luôn nằm trong tập hợp lệ', () => {
    const members = [sale('u1'), sale('u2'), sale('u3')];
    for (const r of [0, 0.5, 0.99]) {
      const out = planRound2([primary()], members, CFG, NOW, () => r);
      expect(['u2', 'u3']).toContain(out[0].userId);
    }
  });

  it('có trần ngày: nạp tồn đáo hạn cùng lúc không dội hết vào một buổi sáng', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      primary({ assignmentId: `a${i}`, contactId: `c${i}`, accessUserIds: ['u1'] }),
    );
    const out = planRound2(many, [sale('u1'), sale('u2', { dailyQuota: 12 })], CFG, NOW);
    // chỉ u2 nhận được (u1 đã là primary của mọi khách), trần 12/ngày
    expect(out).toHaveLength(12);
    expect(out.every((a) => a.userId === 'u2')).toBe(true);
  });

  it('khách quá hạn lâu nhất được thêm sale trước', () => {
    const out = planRound2(
      [
        primary({ assignmentId: 'a2', contactId: 'moi', assignedAt: daysAgo(15) }),
        primary({ assignmentId: 'a1', contactId: 'cu', assignedAt: daysAgo(60) }),
      ],
      [sale('u1'), sale('u2', { dailyQuota: 1 })],
      CFG, NOW,
    );
    expect(out).toEqual([{ contactId: 'cu', userId: 'u2' }]);
  });
});

describe('planEscalations', () => {
  it('gắn cờ khách quá 28 ngày chưa chốt', () => {
    const out = planEscalations([primary({ assignedAt: daysAgo(30) })], CFG, NOW);
    expect(out).toEqual([{ assignmentId: 'a1', contactId: 'c1' }]);
  });

  it('đã gắn cờ rồi thì không báo lại (chạy lại mỗi ngày không spam)', () => {
    const p = primary({ assignedAt: daysAgo(30), escalatedAt: daysAgo(1) });
    expect(planEscalations([p], CFG, NOW)).toEqual([]);
  });

  it('khách đã chốt thì không gắn cờ', () => {
    expect(planEscalations([primary({ assignedAt: daysAgo(30), closed: true })], CFG, NOW)).toEqual([]);
  });

  it('chưa tới 28 ngày thì chưa gắn', () => {
    expect(planEscalations([primary({ assignedAt: daysAgo(27) })], CFG, NOW)).toEqual([]);
  });
});

describe('buildPlan', () => {
  it('vòng 2 nhìn thấy tải mà vòng 1 vừa tạo trong CÙNG lần chạy', () => {
    // u2 và u3 khởi điểm bằng tải. Vòng 1 có đúng 1 lead → hoà, tie-break theo
    // userId đưa nó cho u2. Sang vòng 2 (u1 là primary nên chỉ u2/u3 tranh),
    // nếu dùng ảnh chụp tải CŨ thì u2/u3 vẫn hoà 0-0 và rng=0 sẽ chọn u2. Chỉ khi
    // vòng 2 thấy được lead u2 vừa nhận thì u3 mới thắng tuyệt đối.
    const plan = buildPlan({
      leads: leads(1),
      primaries: [primary({ accessUserIds: ['u1'] })],
      members: [
        sale('u1', { activeLoad: 100 }),
        sale('u2', { activeLoad: 0 }),
        sale('u3', { activeLoad: 0 }),
      ],
      config: CFG,
      now: NOW,
      rng: () => 0,
    });
    expect(plan.round1).toEqual([{ contactId: 'c000', userId: 'u2' }]);
    expect(plan.round2).toEqual([{ contactId: 'c1', userId: 'u3' }]);
  });

  it('hoà tải ở vòng 1 thì tie-break ổn định, kết quả cân bằng tuyệt đối trong sai số 1', () => {
    const out = planRound1(leads(7), [sale('u1'), sale('u2'), sale('u3')]);
    const per = new Map<string, number>();
    for (const a of out) per.set(a.userId, (per.get(a.userId) ?? 0) + 1);
    const counts = [...per.values()].sort();
    expect(out).toHaveLength(7);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('org rỗng người, rỗng lead → kế hoạch rỗng, không nổ', () => {
    const plan = buildPlan({ leads: [], primaries: [], members: [], config: CFG, now: NOW });
    expect(plan).toEqual({ round1: [], round2: [], escalate: [] });
  });

  it('ba việc độc lập nhau: khách vừa tới hạn vòng 2 vừa quá hạn gắn cờ', () => {
    const plan = buildPlan({
      leads: [],
      primaries: [primary({ assignedAt: daysAgo(40), accessUserIds: ['u1'] })],
      members: [sale('u1'), sale('u2')],
      config: CFG,
      now: NOW,
    });
    expect(plan.round2).toEqual([{ contactId: 'c1', userId: 'u2' }]);
    expect(plan.escalate).toEqual([{ assignmentId: 'a1', contactId: 'c1' }]);
  });
});
