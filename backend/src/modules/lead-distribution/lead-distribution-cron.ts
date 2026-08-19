// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * lead-distribution-cron.ts — Chia lead mỗi ngày 07:00 giờ VN.
 *
 * Chỉ có lịch + log. Mọi việc thật nằm ở runner.ts để endpoint run-now dùng chung
 * đúng một đường đi.
 */
import cron from 'node-cron';
import { logger } from '../../shared/utils/logger.js';
import { runAllOrgs } from './runner.js';

export function startLeadDistributionCron(): void {
  // 00:00 UTC = 07:00 giờ VN — sale vào ca là đã có lead trên màn hình.
  // Ghi mốc UTC vì container chạy UTC; node-cron đọc theo TZ tiến trình.
  cron.schedule('0 0 * * *', async () => {
    logger.info('[lead-distribution] bắt đầu chia lead ngày...');
    try {
      const summaries = await runAllOrgs();
      for (const s of summaries) {
        if (s.skipped) {
          logger.debug(`[lead-distribution] org ${s.orgId}: bỏ qua (${s.skipped})`);
          continue;
        }
        const r = s.result;
        logger.info(
          `[lead-distribution] org ${s.orgId}: chia ${r?.round1 ?? 0} lead mới, ` +
            `thêm sale 2 cho ${r?.round2 ?? 0} khách, gắn cờ ${r?.escalated ?? 0}` +
            (r?.errors.length ? ` — ${r.errors.length} lỗi: ${r.errors.slice(0, 3).join('; ')}` : ''),
        );
      }
    } catch (err) {
      logger.error('[lead-distribution] lỗi:', err);
    }
  });
  logger.info('[lead-distribution] đã hẹn lịch chia lead ngày (00:00 UTC / 07:00 VN)');
}
