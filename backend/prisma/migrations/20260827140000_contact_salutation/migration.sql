-- Xưng hô riêng cho từng khách (2026-08-27).
-- Sale muốn gọi khách là "Em"/"Cô"/"Chú" thay vì Anh/Chị suy máy móc từ giới tính.
-- Cột `gender` GIỮ NGUYÊN vai trò cũ (male/female/other/unknown, SDK Zalo tự điền,
-- dùng để lọc/thống kê); cột này chỉ ảnh hưởng chữ hiện ra trong tin nhắn.
-- Idempotent (IF NOT EXISTS) — khớp style các migration trước, an toàn re-run.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "salutation" TEXT;
