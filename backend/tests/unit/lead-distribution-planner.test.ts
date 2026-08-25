// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit test cho luật chia lead (hàm thuần, không DB).
import { describe, it, expect } from 'vitest';
import {
  planRound1,
  planRound2,
  planEscalations,
  buildPlan,
  isContactClosed,
  resolveProvince,
  resolveQuota,
  type SaleMember,
  type CandidateLead,
  type PrimaryAssignment,
  type PlannerConfig,
} from '../../src/modules/lead-distribution/planner.js';

const CFG: PlannerConfig = { dailyQuotaPerUser: 12, coAssignAfterDays: 14, escalateAfterDays: 28 };
const NOW = new Date('2026-08-19T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// Mặc định mọi sale và mọi khách cùng một tỉnh: các test không nói về chi nhánh thì
// hành vi phải y hệt như trước khi có chi nhánh. Test chi nhánh nằm ở describe riêng.
const TINH = 'Hà Nội';

function sale(userId: string, over: Partial<SaleMember> = {}): SaleMember {
  return { userId, dailyQuota: 12, activeLoad: 0, assignedToday: 0, province: TINH, ...over };
}
function leads(n: number, from = 0, province: string | null = TINH): CandidateLead[] {
  return Array.from({ length: n }, (_, i) => ({
    contactId: `c${String(from + i).padStart(3, '0')}`,
    createdAt: new Date(NOW.getTime() - (n - i) * 60_000),
    province,
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
    province: TINH,
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

describe('resolveProvince — địa bàn riêng đè phòng ban', () => {
  it('không đặt riêng thì bám theo phòng ban', () => {
    expect(resolveProvince(null, 'Hà Nội')).toBe('Hà Nội');
    expect(resolveProvince(undefined, 'Hà Nội')).toBe('Hà Nội');
  });
  it('có đặt riêng thì lấy đặt riêng', () => {
    expect(resolveProvince('Hà Nội', null)).toBe('Hà Nội');
  });
  // Ca Gia Linh: trưởng Ban Lãnh Đạo (phòng ban không khai tỉnh) nhưng làm việc ở
  // địa bàn Hà Nội. Không có dòng này thì cô ấy tick nhận lead xong ngồi không.
  it('đặt riêng thắng cả khi phòng ban có tỉnh khác', () => {
    expect(resolveProvince('Hà Nội', 'Hải Phòng')).toBe('Hà Nội');
  });
  it('bỏ đặt riêng thì quay về bám phòng ban', () => {
    expect(resolveProvince(null, 'Hải Phòng')).toBe('Hải Phòng');
  });
  it('cả hai đều trống = không có địa bàn', () => {
    expect(resolveProvince(null, null)).toBeNull();
  });
  // Ô select bị xoá trắng gửi lên '' chứ không phải null. Coi '' là một địa bàn thì
  // nó không khớp tỉnh nào và người đó im lặng rơi khỏi mọi vòng chia.
  it('chuỗi rỗng/toàn khoảng trắng rơi về phòng ban, không thành địa bàn rỗng', () => {
    expect(resolveProvince('', 'Hà Nội')).toBe('Hà Nội');
    expect(resolveProvince('   ', 'Hà Nội')).toBe('Hà Nội');
    expect(resolveProvince('  ', null)).toBeNull();
  });
});

// Kịch bản thật của BMA: Gia Linh là sếp kiêm sale, địa bàn riêng Hà Nội, hạn mức
// thấp; hai sale chi nhánh Hà Nội hạn mức thường. Kiểm đúng những gì đã hứa với
// người dùng — cùng rổ, hạn mức tự chặn, cân theo số khách đang ôm.
describe('sếp kiêm sale bằng địa bàn riêng', () => {
  const giaLinh = () => sale('gia-linh', {
    province: resolveProvince('Hà Nội', null)!, // phòng ban Ban Lãnh Đạo không khai tỉnh
    dailyQuota: 2,
  });

  it('vào chung rổ với sale chi nhánh và nhận được lead Hà Nội', () => {
    const out = planRound1(leads(1), [giaLinh()]);
    expect(out.assigned).toEqual([{ contactId: 'c000', userId: 'gia-linh' }]);
    expect(out.noBranch).toEqual([]);
  });

  it('hạn mức riêng tự chặn, phần còn lại chảy về sale chi nhánh', () => {
    const out = planRound1(leads(10), [giaLinh(), sale('sale-hn1'), sale('sale-hn2')]);
    const cho = (u: string) => out.assigned.filter((a) => a.userId === u).length;
    expect(cho('gia-linh')).toBe(2);
    expect(cho('sale-hn1') + cho('sale-hn2')).toBe(8);
  });

  it('đang ôm nhiều khách cũ thì vòng chia tự né', () => {
    // Gia Linh rảnh hơn → nhận.
    const out = planRound1(leads(1), [giaLinh(), sale('sale-hn1', { activeLoad: 3 })]);
    expect(out.assigned[0].userId).toBe('gia-linh');

    // Đảo ngược tải thì phải sang người kia, dù hạn mức của cô ấy vẫn còn.
    const out2 = planRound1(leads(1), [
      sale('gia-linh', { province: 'Hà Nội', dailyQuota: 2, activeLoad: 9 }),
      sale('sale-hn1', { activeLoad: 3 }),
    ]);
    expect(out2.assigned[0].userId).toBe('sale-hn1');
  });

  it('không lấn sang tỉnh khác', () => {
    const out = planRound1(leads(2, 0, 'Hải Phòng'), [giaLinh()]);
    expect(out.assigned).toEqual([]);
    expect(out.noBranch).toEqual(['c000', 'c001']);
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
    const out = planRound1(leads(6), [sale('u1'), sale('u2'), sale('u3')]).assigned;
    const per = new Map<string, number>();
    for (const a of out) per.set(a.userId, (per.get(a.userId) ?? 0) + 1);
    expect(out).toHaveLength(6);
    expect([...per.values()]).toEqual([2, 2, 2]);
  });

  it('dừng đúng khi mọi người đầy hạn mức, lead dư để lại cho hôm sau', () => {
    const out = planRound1(leads(50), [sale('u1', { dailyQuota: 2 }), sale('u2', { dailyQuota: 3 })]).assigned;
    expect(out).toHaveLength(5);
    expect(out.filter((a) => a.userId === 'u1')).toHaveLength(2);
    expect(out.filter((a) => a.userId === 'u2')).toHaveLength(3);
  });

  it('sale đã nhận đủ hạn mức hôm nay thì không nhận thêm (cron chạy lại không chia gấp đôi)', () => {
    const out = planRound1(leads(10), [
      sale('u1', { dailyQuota: 12, assignedToday: 12 }),
      sale('u2', { dailyQuota: 12, assignedToday: 10 }),
    ]).assigned;
    expect(out).toHaveLength(2);
    expect(out.every((a) => a.userId === 'u2')).toBe(true);
  });

  it('hạn mức 0 thì không nhận lead nào', () => {
    const out = planRound1(leads(5), [sale('u1', { dailyQuota: 0 }), sale('u2')]).assigned;
    expect(out.every((a) => a.userId === 'u2')).toBe(true);
  });

  it('ưu tiên người đang ôm ít khách nhất', () => {
    const out = planRound1(leads(3), [sale('u1', { activeLoad: 50 }), sale('u2', { activeLoad: 0 })]).assigned;
    // u2 nhận 2 lead đầu để đuổi kịp, rồi mới tới lượt u1 khi hoà ở mức 50... không kịp,
    // nên cả 3 đều về u2.
    expect(out.map((a) => a.userId)).toEqual(['u2', 'u2', 'u2']);
  });

  it('lead cũ được chia trước (FIFO), không để lead nằm mãi dưới đáy', () => {
    const old = { contactId: 'cu', createdAt: new Date('2026-01-01T00:00:00Z'), province: TINH };
    const fresh = { contactId: 'cmoi', createdAt: new Date('2026-08-18T00:00:00Z'), province: TINH };
    const out = planRound1([fresh, old], [sale('u1', { dailyQuota: 1 })]).assigned;
    expect(out).toEqual([{ contactId: 'cu', userId: 'u1' }]);
  });

  it('không có sale nào thì trả rỗng, không nổ', () => {
    expect(planRound1(leads(5), []).assigned).toEqual([]);
  });

  it('không có lead nào thì trả rỗng', () => {
    expect(planRound1([], [sale('u1')]).assigned).toEqual([]);
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
    const out = planRound1(leads(7), [sale('u1'), sale('u2'), sale('u3')]).assigned;
    const per = new Map<string, number>();
    for (const a of out) per.set(a.userId, (per.get(a.userId) ?? 0) + 1);
    const counts = [...per.values()].sort();
    expect(out).toHaveLength(7);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('org rỗng người, rỗng lead → kế hoạch rỗng, không nổ', () => {
    const plan = buildPlan({ leads: [], primaries: [], members: [], config: CFG, now: NOW });
    expect(plan).toEqual({ round1: [], round2: [], escalate: [], noBranch: [], membersWithoutBranch: [] });
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

describe('chia theo chi nhánh — khách tỉnh nào về sale tỉnh đó', () => {
  const hn = () => sale('u-hn', { province: 'Hà Nội' });
  const dn = () => sale('u-dn', { province: 'Đà Nẵng' });
  const lead = (id: string, province: string | null, minsAgo = 1): CandidateLead => ({
    contactId: id,
    createdAt: new Date(NOW.getTime() - minsAgo * 60_000),
    province,
  });

  it('khách Hà Nội về sale Hà Nội, khách Đà Nẵng về sale Đà Nẵng', () => {
    const out = planRound1([lead('c1', 'Hà Nội'), lead('c2', 'Đà Nẵng')], [hn(), dn()]);
    expect(out.assigned).toEqual([
      { contactId: 'c1', userId: 'u-hn' },
      { contactId: 'c2', userId: 'u-dn' },
    ]);
    expect(out.noBranch).toEqual([]);
  });

  it('sale rảnh hơn ở tỉnh KHÁC vẫn không được nhận — cân tải không vượt qua chi nhánh', () => {
    // u-dn đang rảnh tuyệt đối, u-hn ôm 99 khách. Không có luật chi nhánh thì lead
    // này về u-dn ngay.
    const out = planRound1(
      [lead('c1', 'Hà Nội')],
      [sale('u-hn', { province: 'Hà Nội', activeLoad: 99 }), sale('u-dn', { province: 'Đà Nẵng', activeLoad: 0 })],
    );
    expect(out.assigned).toEqual([{ contactId: 'c1', userId: 'u-hn' }]);
  });

  it('trong cùng chi nhánh vẫn cân tải như cũ', () => {
    const out = planRound1(
      [lead('c1', 'Hà Nội', 3), lead('c2', 'Hà Nội', 2), lead('c3', 'Hà Nội', 1)],
      [sale('a', { province: 'Hà Nội', activeLoad: 5 }), sale('b', { province: 'Hà Nội', activeLoad: 0 })],
    );
    expect(out.assigned.map((x) => x.userId)).toEqual(['b', 'b', 'b']);
  });

  it('tỉnh chưa lập chi nhánh → treo lại, KHÔNG chia bừa', () => {
    const out = planRound1([lead('c1', 'Cần Thơ')], [hn(), dn()]);
    expect(out.assigned).toEqual([]);
    expect(out.noBranch).toEqual(['c1']);
  });

  it('khách không có tỉnh → treo lại', () => {
    const out = planRound1([lead('c1', null)], [hn(), dn()]);
    expect(out.assigned).toEqual([]);
    expect(out.noBranch).toEqual(['c1']);
  });

  it('sale chưa xếp chi nhánh thì không nhận gì, kể cả khi là người duy nhất', () => {
    const out = planRound1([lead('c1', 'Hà Nội')], [sale('u-lac', { province: null })]);
    expect(out.assigned).toEqual([]);
    expect(out.noBranch).toEqual(['c1']);
  });

  it('tên tỉnh lệch hoa/thường/dấu/tiền tố vẫn ghép đúng', () => {
    const out = planRound1(
      [lead('c1', 'TP. Hà Nội'), lead('c2', 'da nang')],
      [sale('u-hn', { province: 'hà nội' }), sale('u-dn', { province: 'Đà Nẵng' })],
    );
    expect(out.assigned).toEqual([
      { contactId: 'c1', userId: 'u-hn' },
      { contactId: 'c2', userId: 'u-dn' },
    ]);
    expect(out.noBranch).toEqual([]);
  });

  it('chi nhánh hết hạn mức hôm nay KHÔNG bị gắn cờ — mai chia tiếp', () => {
    // Khác hẳn "không có chi nhánh": gắn cờ ở đây thì ngày nào cũng đẻ ra một đống
    // cờ giả và admin sẽ thôi nhìn vào chúng.
    const out = planRound1([lead('c1', 'Hà Nội')], [sale('u-hn', { province: 'Hà Nội', dailyQuota: 0 })]);
    expect(out.assigned).toEqual([]);
    expect(out.noBranch).toEqual([]);
  });

  it('một chi nhánh đầy KHÔNG được chặn chi nhánh khác (bẫy break trong vòng FIFO)', () => {
    // 2 lead Hà Nội cũ hơn đứng đầu hàng, chi nhánh HN đã hết hạn mức. Nếu vòng lặp
    // break thay vì continue thì 2 lead Đà Nẵng phía sau chết theo, dù sale DN rảnh.
    const out = planRound1(
      [lead('h1', 'Hà Nội', 9), lead('h2', 'Hà Nội', 8), lead('d1', 'Đà Nẵng', 7), lead('d2', 'Đà Nẵng', 6)],
      [sale('u-hn', { province: 'Hà Nội', dailyQuota: 0 }), sale('u-dn', { province: 'Đà Nẵng' })],
    );
    expect(out.assigned).toEqual([
      { contactId: 'd1', userId: 'u-dn' },
      { contactId: 'd2', userId: 'u-dn' },
    ]);
  });

  it('buildPlan báo ra sale nào chưa được xếp chi nhánh', () => {
    const plan = buildPlan({
      leads: [],
      primaries: [],
      members: [hn(), sale('u-lac', { province: null }), sale('u-trong', { province: '   ' })],
      config: CFG,
      now: NOW,
    });
    expect(plan.membersWithoutBranch).toEqual(['u-lac', 'u-trong']);
  });
});

describe('vòng 2 theo chi nhánh', () => {
  it('sale chăm cùng phải cùng chi nhánh với khách', () => {
    // Trước khi có chi nhánh, u-dn hoàn toàn có thể bị bốc vào chăm khách Hà Nội.
    const out = planRound2(
      [primary({ province: 'Hà Nội', userId: 'u-hn1', accessUserIds: ['u-hn1'] })],
      [
        sale('u-hn1', { province: 'Hà Nội' }),
        // u-hn2 đang ôm nhiều hơn u-dn: nếu bỏ lọc chi nhánh thì cân tải sẽ chọn
        // u-dn: test phải đỏ khi luật chi nhánh bị gỡ, nếu không nó chẳng chứng minh gì.
        sale('u-hn2', { province: 'Hà Nội', activeLoad: 5 }),
        sale('u-dn', { province: 'Đà Nẵng', activeLoad: 0 }),
      ],
      CFG,
      NOW,
      () => 0,
    );
    expect(out).toEqual([{ contactId: 'c1', userId: 'u-hn2' }]);
  });

  it('chi nhánh chỉ có đúng 1 sale thì không thêm ai, không nổ', () => {
    const out = planRound2(
      [primary({ province: 'Hà Nội', userId: 'u-hn1', accessUserIds: ['u-hn1'] })],
      [sale('u-hn1', { province: 'Hà Nội' }), sale('u-dn', { province: 'Đà Nẵng' })],
      CFG,
      NOW,
      () => 0,
    );
    expect(out).toEqual([]);
  });

  it('khách không có tỉnh thì không ghép thêm ai', () => {
    const out = planRound2(
      [primary({ province: null, userId: 'u-hn1', accessUserIds: ['u-hn1'] })],
      [sale('u-hn1', { province: 'Hà Nội' }), sale('u-hn2', { province: 'Hà Nội' })],
      CFG,
      NOW,
      () => 0,
    );
    expect(out).toEqual([]);
  });
});
