-- Công tắc cho AI đọc ghi chú nội bộ (bảng notes + contacts.notes) khi tóm tắt,
-- phân tích cảm xúc, soạn nháp trả lời và trong trợ lý chat ảo.
-- DEFAULT false: ghi chú là bình luận nội bộ khách không thấy — org đang chạy không
-- bị gửi thêm gì ra provider AI sau khi nâng cấp, phải tự bật trong Cài đặt.
-- IF NOT EXISTS: chạy lại trên DB đã áp tay không nổ.
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "ai_include_notes" BOOLEAN NOT NULL DEFAULT false;
