// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * group-scan-routes.ts — E1 Quét group (🟢 Community).
 * Routes: /api/v1/zalo-accounts/:accountId/group-scans
 *   POST   /                       — tạo scan (selected|all) + enqueue
 *   GET    /:scanId                — trạng thái scan
 *   GET    /:scanId/members        — roster (filter isFriend, phân trang)
 *   POST   /:scanId/to-contacts    — thành viên đã quét → Khách hàng (source='quet-nhom')
 *
 * Auth/error: mirror group-routes.ts (authMiddleware + resolveAccount +
 * checkAccess('read') + handleError).
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { zaloOps } from '../../shared/zalo-operations.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { resolveAccount, checkAccess, handleError } from './zalo-route-helpers.js';
import { enqueueGroupScan } from './group-scan-queue.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { resolveOrCreateContact } from '../contacts/resolve-contact.js';
import { attachContactCollaboratorByUser } from '../contacts/contact-scope.js';
import { SOURCE_GROUP_SCAN } from '../../shared/contact-source.js';

const MAX_GROUPS_PER_SCAN = 5000;

// Trần mỗi lượt "thêm vào khách hàng". Mỗi thành viên tốn vài query dedup, nhóm cộng
// đồng có hàng nghìn người — không chặn thì request treo tới lúc timeout rồi không ai
// biết đã thêm được bao nhiêu. FE gọi lại tới khi `remaining` về 0 (mỗi lượt chỉ lấy
// contactId=null nên chắc chắn tiến, không lặp vô hạn).
const MAX_MEMBERS_PER_IMPORT = 300;

export async function groupScanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  const BASE = '/api/v1/zalo-accounts/:accountId/group-scans';

  // ── Create scan ───────────────────────────────────────────────────────────
  app.post<{ Params: { accountId: string }; Body: { groupIds?: string[]; all?: boolean } }>(
    BASE,
    async (request, reply) => {
      const { accountId } = request.params;
      const { groupIds, all } = request.body ?? {};
      if (!all && (!Array.isArray(groupIds) || groupIds.length === 0)) {
        return reply.status(400).send({ error: 'groupIds array is required when all is not set' });
      }
      // Chặn payload khổng lồ (review #4): IN (...) lớn + job/row flood.
      if (Array.isArray(groupIds) && groupIds.length > MAX_GROUPS_PER_SCAN) {
        return reply
          .status(400)
          .send({ error: `too many groupIds (max ${MAX_GROUPS_PER_SCAN})` });
      }
      try {
        const account = await resolveAccount(accountId, request.user!.orgId);
        if (!(await checkAccess(request, reply, accountId, 'read'))) return;

        // Dedup in-flight (review #4): 1 nick chỉ 1 scan đang chạy — tránh 2 scan
        // cùng nick race upsert + flood job. Trả scan đang chạy thay vì tạo mới.
        const inFlight = await prisma.groupScan.findFirst({
          where: { zaloAccountId: accountId, orgId: account.orgId, state: { in: ['queued', 'running'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (inFlight) {
          return reply.status(409).send({ error: 'a scan is already running for this account', scan: inFlight });
        }

        let ids: string[];
        let scope: string;
        if (all) {
          // Snapshot toàn bộ group nick đang tham gia → groupIds.
          const res = (await zaloOps.getAllGroups(accountId)) as {
            gridVerMap?: Record<string, string>;
          };
          ids = Object.keys(res?.gridVerMap ?? {});
          scope = 'all';
        } else {
          ids = [...new Set(groupIds!.map(String))];
          scope = 'selected';
        }

        const scan = await prisma.groupScan.create({
          data: {
            orgId: account.orgId,
            zaloAccountId: accountId,
            scope,
            groupIds: ids,
            state: 'queued',
            totalGroups: ids.length,
          },
        });

        await enqueueGroupScan(scan.id);
        return reply.status(201).send({ scan });
      } catch (err) {
        return handleError(reply, err, 'createGroupScan');
      }
    },
  );

  // ── Scan status ───────────────────────────────────────────────────────────
  app.get<{ Params: { accountId: string; scanId: string } }>(
    `${BASE}/:scanId`,
    async (request, reply) => {
      const { accountId, scanId } = request.params;
      try {
        await resolveAccount(accountId, request.user!.orgId);
        if (!(await checkAccess(request, reply, accountId, 'read'))) return;

        const scan = await prisma.groupScan.findFirst({
          where: { id: scanId, zaloAccountId: accountId, orgId: request.user!.orgId },
        });
        if (!scan) return reply.status(404).send({ error: 'Scan not found' });
        return { scan };
      } catch (err) {
        return handleError(reply, err, 'getGroupScan');
      }
    },
  );

  // ── Roster (members of scan's groups) ─────────────────────────────────────
  app.get<{
    Params: { accountId: string; scanId: string };
    Querystring: { isFriend?: string; page?: string; limit?: string };
  }>(`${BASE}/:scanId/members`, async (request, reply) => {
    const { accountId, scanId } = request.params;
    const { isFriend, page, limit } = request.query;
    try {
      await resolveAccount(accountId, request.user!.orgId);
      if (!(await checkAccess(request, reply, accountId, 'read'))) return;

      const scan = await prisma.groupScan.findFirst({
        where: { id: scanId, zaloAccountId: accountId, orgId: request.user!.orgId },
        select: { groupIds: true },
      });
      if (!scan) return reply.status(404).send({ error: 'Scan not found' });

      const groupIds: string[] = Array.isArray(scan.groupIds)
        ? (scan.groupIds as unknown[]).map(String)
        : [];

      const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit ?? '50', 10) || 50));

      const where: {
        zaloAccountId: string;
        groupId: { in: string[] };
        isFriend?: boolean;
      } = { zaloAccountId: accountId, groupId: { in: groupIds } };
      if (isFriend === 'true') where.isFriend = true;
      else if (isFriend === 'false') where.isFriend = false;

      const [members, total] = await Promise.all([
        prisma.groupMember.findMany({
          where,
          orderBy: { lastSeenAt: 'desc' },
          skip: (pageNum - 1) * limitNum,
          take: limitNum,
        }),
        prisma.groupMember.count({ where }),
      ]);

      return { members, total, page: pageNum, limit: limitNum };
    } catch (err) {
      return handleError(reply, err, 'getGroupScanMembers');
    }
  });

  // ── Thành viên đã quét → Khách hàng ───────────────────────────────────────
  // Body: { memberUids?: string[] } chọn tay, hoặc { all: true } lấy hết theo bộ lọc
  // hiện tại. `isFriend` tri-state khớp ĐÚNG param của GET /members: bỏ trống = tất cả,
  // true = chỉ bạn bè, false = chỉ người lạ — để "thêm tất cả" nhập đúng tập mà sale
  // đang nhìn thấy, không phải một tập rộng hơn.
  // Trả về số đã tạo/đã có + `remaining` để FE gọi tiếp cho tới khi hết.
  //
  // Dedup: resolveOrCreateContact() là bộ khớp chuẩn của CRM (Friend → globalId →
  // SĐT → stub). Thành viên đã là khách sẵn thì KHÔNG tạo mới và KHÔNG đè source —
  // khách đến từ Facebook mà tình cờ ở trong nhóm không được biến thành 'quet-nhom'.
  //
  // CỐ Ý không bắn trigger 'contact_created': nhập một lượt vài trăm người lạ mà mỗi
  // người kích một kịch bản tự động thì đúng bằng cái "nhắn hàng loạt dễ bay nick" mà
  // chính màn này đang cảnh báo. Sale gắn kịch bản thủ công sau khi lọc.
  app.post<{
    Params: { accountId: string; scanId: string };
    Body: { memberUids?: string[]; all?: boolean; isFriend?: boolean };
  }>(
    `${BASE}/:scanId/to-contacts`,
    { preHandler: requireGrant('contact', 'create') },
    async (request, reply) => {
      const { accountId, scanId } = request.params;
      const { memberUids, all, isFriend } = request.body ?? {};
      const user = request.user!;

      if (!all && (!Array.isArray(memberUids) || memberUids.length === 0)) {
        return reply
          .status(400)
          .send({ error: 'memberUids array is required when all is not set' });
      }

      try {
        const account = await resolveAccount(accountId, user.orgId);
        if (!(await checkAccess(request, reply, accountId, 'read'))) return;

        const scan = await prisma.groupScan.findFirst({
          where: { id: scanId, zaloAccountId: accountId, orgId: user.orgId },
          select: { groupIds: true },
        });
        if (!scan) return reply.status(404).send({ error: 'Scan not found' });

        const groupIds: string[] = Array.isArray(scan.groupIds)
          ? (scan.groupIds as unknown[]).map(String)
          : [];

        // contactId=null là điều kiện khiến "thêm tất cả" tiến được qua từng lượt:
        // người đã thêm rơi khỏi tập ngay, lượt sau lấy đúng phần còn lại.
        const where = {
          orgId: account.orgId,
          zaloAccountId: accountId,
          groupId: { in: groupIds },
          contactId: null,
          ...(typeof isFriend === 'boolean' ? { isFriend } : {}),
          ...(all ? {} : { memberUid: { in: [...new Set(memberUids!.map(String))] } }),
        };

        const [candidates, matching] = await Promise.all([
          prisma.groupMember.findMany({
            where,
            orderBy: { lastSeenAt: 'desc' },
            take: MAX_MEMBERS_PER_IMPORT,
            select: {
              id: true, memberUid: true, globalId: true,
              displayName: true, zaloName: true, avatarUrl: true,
            },
          }),
          prisma.groupMember.count({ where }),
        ]);

        let created = 0;
        let linked = 0;
        let failed = 0;

        for (const m of candidates) {
          try {
            const res = await resolveOrCreateContact({
              orgId: account.orgId,
              zaloAccountId: accountId,
              zaloUidInNick: m.memberUid,
              zaloGlobalId: m.globalId,
              fallbackFullName: m.displayName || m.zaloName || null,
              fallbackAvatarUrl: m.avatarUrl,
              // KHÔNG enrich qua getUserInfo: vài trăm lượt gọi SDK liên tiếp là đúng
              // kiểu hành vi làm nick bị khoá. Tên/avatar lấy từ roster đã quét là đủ.
              enrichViaGetUserInfo: false,
            });

            if (res.created) {
              // Chỉ khách MỚI mới mang nguồn 'quet-nhom' và về tay người bấm nút.
              await prisma.contact.update({
                where: { id: res.id },
                data: {
                  source: SOURCE_GROUP_SCAN,
                  sourceDate: new Date(),
                  assignedUserId: user.id,
                },
              });
              // Không có ContactAccess thì màn Khách hàng của sale trắng trơn — khách
              // vừa thêm coi như biến mất. Bắt buộc, không phải best-effort.
              await prisma.contactAccess.upsert({
                where: { contactId_userId: { contactId: res.id, userId: user.id } },
                update: { role: 'primary' },
                create: {
                  orgId: account.orgId,
                  contactId: res.id,
                  userId: user.id,
                  role: 'primary',
                  source: SOURCE_GROUP_SCAN,
                },
              });
              created++;
            } else {
              // Khách đã có chủ: chỉ xin quyền xem chung, không cướp primary.
              await attachContactCollaboratorByUser({
                orgId: account.orgId,
                contactId: res.id,
                userId: user.id,
                source: SOURCE_GROUP_SCAN,
              });
              linked++;
            }

            await prisma.groupMember.update({
              where: { id: m.id },
              data: { contactId: res.id },
            });
          } catch (err) {
            // Một thành viên hỏng không được chặn phần còn lại — nhóm nghìn người mà
            // dừng ở người thứ 3 thì sale phải bấm lại từ đầu.
            failed++;
            logger.error(
              `[group-scan] to-contacts scan=${scanId} uid=${m.memberUid} failed: ${(err as Error).message}`,
            );
          }
        }

        const processed = created + linked;
        return {
          created,
          linked,
          failed,
          // Còn lại sau lượt này. FE lặp tới khi = 0.
          remaining: Math.max(0, matching - processed),
        };
      } catch (err) {
        return handleError(reply, err, 'groupScanToContacts');
      }
    },
  );
}
