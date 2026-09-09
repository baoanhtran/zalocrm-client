// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * M53 2026-05-30 — Type + validator cho extracted entities AI Trợ Lý
 * trả về trong Virtual Chat. Mapping qua Contact fields.
 *
 * KHÔNG dùng zod vì backend chưa có dep — dùng manual type guard.
 */

export type Gender = 'M' | 'F' | null;
export type IncomeRange = '0-10' | '10-20' | '20-50' | '50+' | null;
export type LeadSource = 'facebook' | 'zalo' | 'gioi_thieu' | 'hotline' | 'website' | 'khac';

/** Du học hay xuất khẩu lao động — hai loại hồ sơ khác hẳn nhau, hỏi sớm nhất. */
export type ServiceType = 'du_hoc' | 'xkld' | 'chua_ro';
/** Trình độ đã hoàn thành — quyết định trực tiếp khả năng đậu visa. */
export type EduLevel = 'thpt' | 'trung_cap' | 'cao_dang' | 'dai_hoc' | 'khac';
export type DepartureTimeline = '3_thang' | '6_thang' | '1_nam' | 'chua_ro';

/** Nhu cầu du học / XKLĐ (BMA). Thay khối bất động sản của bản gốc. */
export interface ExtractedStudyAbroadNeed {
  serviceType?: ServiceType;
  country?: string;          // Hàn Quốc, Nhật Bản, Đài Loan, Đức, Canada, Úc...
  eduLevel?: EduLevel;
  gpa?: number;              // điểm trung bình, thang 10
  language?: string;         // "TOPIK 2", "N5", "chưa học"
  budgetMin?: number;        // TRIỆU VND (không phải tỷ — xem GPA_MAX/BUDGET_MAX)
  budgetMax?: number;
  departureTimeline?: DepartureTimeline;
  visaRejected?: boolean;    // đã từng trượt visa — yếu tố loại hồ sơ
  decisionMaker?: string;    // khách thường 18 tuổi, bố mẹ mới là người quyết
}

export interface ExtractedEntities {
  fullName?: string;
  gender?: Gender;
  birthYear?: number;
  occupation?: string;
  incomeRange?: IncomeRange;
  province?: string;
  district?: string;
  ward?: string;
  studyAbroadNeed?: ExtractedStudyAbroadNeed;
  leadSource?: LeadSource;
  tags?: string[];
  confidenceScore: number;
  missingFields: string[];
}

const ENUM_SERVICE_TYPE = new Set(['du_hoc', 'xkld', 'chua_ro']);
const ENUM_EDU_LEVEL = new Set(['thpt', 'trung_cap', 'cao_dang', 'dai_hoc', 'khac']);
const ENUM_DEPARTURE_TIMELINE = new Set(['3_thang', '6_thang', '1_nam', 'chua_ro']);
const ENUM_LEAD_SOURCE = new Set(['facebook', 'zalo', 'gioi_thieu', 'hotline', 'website', 'khac']);
const ENUM_INCOME = new Set(['0-10', '10-20', '20-50', '50+']);

const GPA_MAX = 10;
/** Chi phí du học/XKLĐ tính bằng TRIỆU. Sàn 1 chặn số kiểu "0.3" — dấu hiệu AI
 *  còn nghĩ theo đơn vị "tỷ" của prompt bất động sản cũ. */
const BUDGET_MIN_TRIEU = 1;
const BUDGET_MAX_TRIEU = 5000;

/**
 * Manual safeParse — fail open: drop invalid field but keep valid ones.
 * Trả null nếu input KHÔNG phải object hoặc thiếu confidenceScore/missingFields.
 */
export function safeParseEntities(input: unknown): { success: true; data: ExtractedEntities } | { success: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { success: false, error: 'Not an object' };
  }
  const obj = input as Record<string, unknown>;
  const out: ExtractedEntities = {
    confidenceScore: typeof obj.confidenceScore === 'number'
      ? Math.max(0, Math.min(1, obj.confidenceScore))
      : 0,
    missingFields: Array.isArray(obj.missingFields)
      ? obj.missingFields.filter((s) => typeof s === 'string').slice(0, 20) as string[]
      : [],
  };

  if (typeof obj.fullName === 'string' && obj.fullName.length <= 200) out.fullName = obj.fullName;
  if (obj.gender === 'M' || obj.gender === 'F') out.gender = obj.gender;
  if (typeof obj.birthYear === 'number' && obj.birthYear >= 1940 && obj.birthYear <= 2015) {
    out.birthYear = Math.floor(obj.birthYear);
  }
  if (typeof obj.occupation === 'string' && obj.occupation.length <= 200) out.occupation = obj.occupation;
  if (typeof obj.incomeRange === 'string' && ENUM_INCOME.has(obj.incomeRange)) {
    out.incomeRange = obj.incomeRange as IncomeRange;
  }
  if (typeof obj.province === 'string') out.province = obj.province.slice(0, 100);
  if (typeof obj.district === 'string') out.district = obj.district.slice(0, 100);
  if (typeof obj.ward === 'string') out.ward = obj.ward.slice(0, 100);
  if (typeof obj.leadSource === 'string' && ENUM_LEAD_SOURCE.has(obj.leadSource)) {
    out.leadSource = obj.leadSource as LeadSource;
  }
  if (Array.isArray(obj.tags)) {
    out.tags = obj.tags
      .filter((t) => typeof t === 'string')
      .slice(0, 10)
      .map((t) => (t as string).slice(0, 50));
  }
  if (obj.studyAbroadNeed && typeof obj.studyAbroadNeed === 'object') {
    const sa = obj.studyAbroadNeed as Record<string, unknown>;
    const need: ExtractedStudyAbroadNeed = {};
    const budget = (v: unknown): number | undefined =>
      typeof v === 'number' && v >= BUDGET_MIN_TRIEU && v <= BUDGET_MAX_TRIEU ? v : undefined;

    if (typeof sa.serviceType === 'string' && ENUM_SERVICE_TYPE.has(sa.serviceType)) {
      need.serviceType = sa.serviceType as ServiceType;
    }
    if (typeof sa.country === 'string') need.country = sa.country.slice(0, 100);
    if (typeof sa.eduLevel === 'string' && ENUM_EDU_LEVEL.has(sa.eduLevel)) {
      need.eduLevel = sa.eduLevel as EduLevel;
    }
    if (typeof sa.gpa === 'number' && sa.gpa >= 0 && sa.gpa <= GPA_MAX) need.gpa = sa.gpa;
    if (typeof sa.language === 'string') need.language = sa.language.slice(0, 100);

    const bMin = budget(sa.budgetMin);
    const bMax = budget(sa.budgetMax);
    if (bMin !== undefined) need.budgetMin = bMin;
    if (bMax !== undefined) need.budgetMax = bMax;

    if (typeof sa.departureTimeline === 'string' && ENUM_DEPARTURE_TIMELINE.has(sa.departureTimeline)) {
      need.departureTimeline = sa.departureTimeline as DepartureTimeline;
    }
    // Chỉ nhận boolean thật — chuỗi "false" là truthy, nhận vào sẽ đảo ngược ý nghĩa.
    if (typeof sa.visaRejected === 'boolean') need.visaRejected = sa.visaRejected;
    if (typeof sa.decisionMaker === 'string') need.decisionMaker = sa.decisionMaker.slice(0, 100);

    if (Object.keys(need).length > 0) out.studyAbroadNeed = need;
  }

  return { success: true, data: out };
}
