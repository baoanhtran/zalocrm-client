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
  // 07:00 giờ VN — sale vào ca là đã có lead trên màn hình.
  //
  // Khai báo timezone TƯỜNG MINH, đừng suy ra từ TZ tiến trình. Container hiện đặt
  // TZ=Asia/Ho_Chi_Minh (docker/Dockerfile:33 + docker-compose.yml:63), nhưng nếu ai
  // đó gỡ ra hoặc chạy ngoài Docker thì cùng một biểu thức cron sẽ nhảy sang giờ khác
  // mà không báo gì. Ghi rõ ở đây thì đúng trong mọi trường hợp.
  cron.schedule('0 7 * * *', async () => {
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
  }, { timezone: 'Asia/Ho_Chi_Minh' });
  logger.info('[lead-distribution] đã hẹn lịch chia lead ngày (07:00 giờ VN)');
}
