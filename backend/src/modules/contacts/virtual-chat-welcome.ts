// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lời chào đầu tiên của chat nội bộ — hardcode, KHÔNG gọi Gemini (không tốn token).
 *
 * Chat nội bộ mở được cho mọi KH, kể cả KH đã có chat Zalo → không khẳng định "KH chưa có Zalo".
 */
export function buildVirtualChatWelcome(name: string, phone: string | null): string {
  const khPhone = phone || 'chưa có SĐT';
  return (
    `Chào anh/chị! Đây là kênh nhật ký chăm sóc nội bộ cho KH **${name}** (SĐT ${khPhone}) — tin nhắn ở đây KHÔNG gửi đi Zalo.\n\n` +
    `Anh/chị có thể chat vào đây để ghi nhật ký chăm sóc + bổ sung thông tin KH. ` +
    `Mỗi tin anh/chị gõ, em sẽ tự động gợi ý câu hỏi khai thác và đề xuất cập nhật thông tin lên hệ thống.\n\n` +
    `Để bắt đầu, anh/chị thử gõ vài thông tin đã biết về KH ${name} (vd: năm sinh, trường đang học, nước muốn đi, ngành nghề quan tâm, khả năng tài chính...) để em hỗ trợ nhé!`
  );
}
