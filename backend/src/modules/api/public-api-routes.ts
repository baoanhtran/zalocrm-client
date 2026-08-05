// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * public-api-routes.ts — External REST API authenticated via API key (X-Api-Key header).
 * Provides read/write access to contacts, conversations, appointments, and message sending.
 * All routes prefixed /api/public/ — no JWT required, orgId injected from API key lookup.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

// ── API key auth middleware ────────────────────────────────────────────────────

async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-api-key'] as string;
  if (!apiKey) return reply.status(401).send({ error: 'API key required' });

  const setting = await prisma.appSetting.findFirst({
    where: { settingKey: 'public_api_key', valuePlain: apiKey },
  });
  if (!setting) return reply.status(401).send({ error: 'Invalid API key' });

  (request as any).orgId = setting.orgId;
}

// ── Route registration ────────────────────────────────────────────────────────

// ── ContactAccess helpers ─────────────────────────────────────────────────────
// Trong ZaloCRM, thứ quyết định một sale CÓ NHÌN THẤY khách hay không là bản ghi
// ContactAccess (xem getContactScope): owner/admin thấy tất cả, mọi role khác chỉ thấy
// contact có ContactAccess trỏ tới mình. Contact tạo qua public API mà không có bản ghi này
// thì sale được giao vẫn không thấy gì — nên mọi đường gán assignedUserId ở đây đều phải
// tạo ContactAccess kèm theo, đúng như luồng tạo KH trong giao diện đang làm.

async function assertOrgUser(orgId: string, userId: string): Promise<boolean> {
  const u = await prisma.user.findFirst({
    where: { id: userId, orgId, isActive: true },
    select: { id: true },
  });
  return !!u;
}

async function grantPrimary(orgId: string, contactId: string, userId: string): Promise<void> {
  await prisma.contactAccess.upsert({
    where: { contactId_userId: { contactId, userId } },
    update: { role: 'primary' },
    create: { orgId, contactId, userId, role: 'primary', source: 'public_api_assignment' },
  });
}

async function grantCollaborator(orgId: string, contactId: string, userId: string): Promise<void> {
  await prisma.contactAccess.upsert({
    where: { contactId_userId: { contactId, userId } },
    update: {}, // đã có thì giữ nguyên role (không hạ primary xuống collaborator)
    create: { orgId, contactId, userId, role: 'collaborator', source: 'public_api_assignment' },
  });
}

// ── Route registration ────────────────────────────────────────────────────────

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', apiKeyAuth);

  // ── Users ────────────────────────────────────────────────────────────────
  // Cho hệ thống ngoài (vd Apps Script chia lead) ánh xạ tên sale → userId trước khi
  // gửi assignedUserId. Chỉ trả user đang hoạt động của org gắn với API key.
  app.get('/api/public/users', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const users = await prisma.user.findMany({
        where: { orgId, isActive: true },
        select: { id: true, fullName: true, email: true, phone: true, role: true },
        orderBy: { fullName: 'asc' },
      });
      return { users };
    } catch (err) {
      logger.error('[public-api] GET /users error:', err);
      return reply.status(500).send({ error: 'Failed to fetch users' });
    }
  });

  // ── Contacts ─────────────────────────────────────────────────────────────

  app.get('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { search = '', status = '', limit = '20' } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      const contacts = await prisma.contact.findMany({
        where,
        select: {
          id: true, fullName: true, phone: true, email: true,
          source: true, status: true, notes: true, tags: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { contacts };
    } catch (err) {
      logger.error('[public-api] GET /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contacts' });
    }
  });

  app.get('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };

      const contact = await prisma.contact.findFirst({
        where: { id, orgId },
        include: {
          appointments: { orderBy: { appointmentDate: 'desc' }, take: 5 },
          _count: { select: { conversations: true } },
        },
      });

      if (!contact) return reply.status(404).send({ error: 'Contact not found' });
      return contact;
    } catch (err) {
      logger.error('[public-api] GET /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to fetch contact' });
    }
  });

  app.post('/api/public/contacts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.fullName && !body?.phone) {
        return reply.status(400).send({ error: 'fullName or phone is required' });
      }

      // Gán sale phụ trách (tuỳ chọn). Sai userId thì báo lỗi to thay vì tạo contact vô chủ
      // im lặng — bên gọi nên resolve tên sale qua GET /api/public/users trước.
      if (body.assignedUserId && !(await assertOrgUser(orgId, body.assignedUserId))) {
        return reply.status(400).send({ error: 'assignedUserId not found in this organization' });
      }

      const contact = await prisma.contact.create({
        data: {
          orgId,
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status ?? 'new',
          notes: body.notes,
          tags: body.tags ?? [],
          assignedUserId: body.assignedUserId || undefined,
        },
      });

      if (contact.assignedUserId) {
        await grantPrimary(orgId, contact.id, contact.assignedUserId);
      }

      return reply.status(201).send(contact);
    } catch (err) {
      logger.error('[public-api] POST /contacts error:', err);
      return reply.status(500).send({ error: 'Failed to create contact' });
    }
  });

  app.put('/api/public/contacts/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, any>;

      const existing = await prisma.contact.findFirst({
        where: { id, orgId },
        select: { id: true, assignedUserId: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Contact not found' });

      if (body.assignedUserId && !(await assertOrgUser(orgId, body.assignedUserId))) {
        return reply.status(400).send({ error: 'assignedUserId not found in this organization' });
      }

      // KH đã có người phụ trách thì KHÔNG cướp quyền: giữ nguyên assignedUserId, chỉ cấp
      // thêm quyền xem (collaborator) cho người mới. KH chưa ai phụ trách thì gán primary.
      const takeOver = !!body.assignedUserId && !existing.assignedUserId;

      const updated = await prisma.contact.update({
        where: { id },
        data: {
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          source: body.source,
          status: body.status,
          notes: body.notes,
          tags: body.tags,
          assignedUserId: takeOver ? body.assignedUserId : undefined,
        },
      });

      if (body.assignedUserId) {
        if (takeOver) await grantPrimary(orgId, id, body.assignedUserId);
        else await grantCollaborator(orgId, id, body.assignedUserId);
      }

      return updated;
    } catch (err) {
      logger.error('[public-api] PUT /contacts/:id error:', err);
      return reply.status(500).send({ error: 'Failed to update contact' });
    }
  });

  // ── Conversations ─────────────────────────────────────────────────────────

  app.get('/api/public/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { limit = '20' } = request.query as Record<string, string>;

      const conversations = await prisma.conversation.findMany({
        where: { orgId, deletedAt: null },
        select: {
          id: true, threadType: true, externalThreadId: true,
          lastMessageAt: true, unreadCount: true, isReplied: true,
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        take: Math.min(parseInt(limit) || 20, 100),
      });

      return { conversations };
    } catch (err) {
      logger.error('[public-api] GET /conversations error:', err);
      return reply.status(500).send({ error: 'Failed to fetch conversations' });
    }
  });

  app.get('/api/public/conversations/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { id } = request.params as { id: string };
      const { limit = '50' } = request.query as Record<string, string>;

      const conv = await prisma.conversation.findFirst({ where: { id, orgId }, select: { id: true } });
      if (!conv) return reply.status(404).send({ error: 'Conversation not found' });

      const messages = await prisma.message.findMany({
        where: { conversationId: id, isDeleted: false },
        orderBy: { sentAt: 'desc' },
        take: Math.min(parseInt(limit) || 50, 200),
        select: {
          id: true, senderType: true, senderName: true,
          content: true, contentType: true, sentAt: true, attachments: true,
        },
      });

      return { messages };
    } catch (err) {
      logger.error('[public-api] GET /conversations/:id/messages error:', err);
      return reply.status(500).send({ error: 'Failed to fetch messages' });
    }
  });

  // ── Appointments ──────────────────────────────────────────────────────────

  app.get('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const { from, to } = request.query as Record<string, string>;

      const where: any = { orgId };
      if (from || to) {
        where.appointmentDate = {};
        if (from) where.appointmentDate.gte = new Date(from);
        if (to) where.appointmentDate.lte = new Date(to);
      }

      const appointments = await prisma.appointment.findMany({
        where,
        include: { contact: { select: { id: true, fullName: true, phone: true } } },
        orderBy: { appointmentDate: 'asc' },
        take: 100,
      });

      return { appointments };
    } catch (err) {
      logger.error('[public-api] GET /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to fetch appointments' });
    }
  });

  app.post('/api/public/appointments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.contactId || !body?.appointmentDate) {
        return reply.status(400).send({ error: 'contactId and appointmentDate are required' });
      }

      const contact = await prisma.contact.findFirst({ where: { id: body.contactId, orgId }, select: { id: true } });
      if (!contact) return reply.status(404).send({ error: 'Contact not found' });

      const appointment = await prisma.appointment.create({
        data: {
          orgId,
          contactId: body.contactId,
          appointmentDate: new Date(body.appointmentDate),
          appointmentTime: body.appointmentTime,
          type: body.type,
          notes: body.notes,
        },
      });

      return reply.status(201).send(appointment);
    } catch (err) {
      logger.error('[public-api] POST /appointments error:', err);
      return reply.status(500).send({ error: 'Failed to create appointment' });
    }
  });

  // ── Messages send ─────────────────────────────────────────────────────────

  app.post('/api/public/messages/send', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).orgId as string;
      const body = request.body as Record<string, any>;

      if (!body?.zaloAccountId || !body?.threadId || !body?.content) {
        return reply.status(400).send({ error: 'zaloAccountId, threadId, and content are required' });
      }

      // Verify account belongs to org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: body.zaloAccountId, orgId },
        select: { id: true, status: true, archivedAt: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account not found' });
      // T7b (YC2 2026-06-20): nick ĐÃ XÓA (archivedAt) → 409, trước check kết nối.
      if (account.archivedAt) {
        return reply.status(409).send({ error: 'Nick này đã bị xóa — không gửi được. Kết nối lại nick để tiếp tục.', code: 'NICK_ARCHIVED' });
      }
      if (account.status !== 'connected') {
        return reply.status(422).send({ error: 'Zalo account is not connected' });
      }

      // Dynamically import zaloPool to avoid circular deps
      const { zaloPool } = await import('../zalo/zalo-pool.js');
      const api = zaloPool.getApi(body.zaloAccountId);
      if (!api) return reply.status(422).send({ error: 'Zalo account not active in pool' });

      const threadType = body.threadType === 'group' ? 1 : 0;
      await api.sendMessage(body.content, body.threadId, threadType);

      return { success: true };
    } catch (err) {
      logger.error('[public-api] POST /messages/send error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });
}
