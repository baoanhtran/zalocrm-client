-- Nhập khách từ Excel (2026-09-10).
--
-- Quản lý chọn một tỉnh, tải lên file .xlsx/.csv nhiều dòng khách; app tự dò cột họ
-- tên / ngày sinh / SĐT rồi tạo khách hàng loạt với source = 'nhap-excel:<Tỉnh>'.
--
-- Bảng dưới đây là thứ giữ cho thao tác đó hoàn tác được. Không có nó, file nhập nhầm
-- không gỡ ra được nữa: khách vừa nhập lẫn vào giữa hàng nghìn khách cũ, mà lọc theo
-- ngày tạo là vơ luôn cả khách sale thêm tay cùng lúc.
--
-- Cột "contacts"."import_batch_id" đã có sẵn từ trước (trỏ tới một bảng chưa bao giờ
-- ra đời) nên KHÔNG phải đụng bảng contacts — chỉ dùng đúng mục đích ban đầu của nó.
-- Additive hoàn toàn + IF NOT EXISTS → an toàn chạy trên prod đang có dữ liệu.

CREATE TABLE IF NOT EXISTS "contact_import_batches" (
  "id"                TEXT PRIMARY KEY,
  "org_id"            TEXT NOT NULL,
  "created_by_id"     TEXT NOT NULL,
  -- Tên file gốc: thứ duy nhất giúp nhận ra lô nào là lô nào khi mở lại sau vài tuần.
  "file_name"         TEXT NOT NULL,
  -- Tỉnh đã chọn ở hộp thoại, lưu tách khỏi "source" để sau này đổi cách đặt tên nguồn
  -- không mất dữ liệu địa bàn.
  "province"          TEXT NOT NULL,
  "source"            TEXT NOT NULL,
  "total_rows"        INTEGER NOT NULL,
  "created_count"     INTEGER NOT NULL DEFAULT 0,
  "skipped_duplicate" INTEGER NOT NULL DEFAULT 0,
  "skipped_invalid"   INTEGER NOT NULL DEFAULT 0,
  -- Hoàn tác chỉ xoá khách còn nguyên trạng (chưa hội thoại/ghi chú/lịch hẹn/chưa bị
  -- chia lead), nên undone_count thường nhỏ hơn created_count. Giữ cả hai số để người
  -- dùng hiểu vì sao còn sót lại vài khách.
  "undone_at"         TIMESTAMP(3),
  "undone_count"      INTEGER,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "contact_import_batches_org_id_created_at_idx"
  ON "contact_import_batches" ("org_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_import_batches_org_id_fkey') THEN
    ALTER TABLE "contact_import_batches" ADD CONSTRAINT "contact_import_batches_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_import_batches_created_by_id_fkey') THEN
    ALTER TABLE "contact_import_batches" ADD CONSTRAINT "contact_import_batches_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Đưa "Nhập khách từ Excel" vào ma trận phân quyền (resource contact_import, chỉ có
-- cột Truy cập). seedDefaultPermissionGroups() không cập nhật nhóm đã tồn tại, nên
-- nhóm trong DB phải vá thẳng ở đây — nếu không, "Trưởng phòng" của tổ chức đang chạy
-- sẽ không thấy nút dù code mặc định có bật.
--
-- Mọi câu đều có `NOT (grants ? 'contact_import')` nên chạy lại không đè lên tick
-- admin đã tự chỉnh.

UPDATE permission_groups
SET grants = grants || '{"contact_import":{"access":true}}'::jsonb
WHERE is_system = true AND name IN ('Admin', 'Trưởng phòng')
  AND NOT (grants ? 'contact_import');

-- Các nhóm còn lại (CEO, Sale, Sale Senior, Marketing, HC-NS) và mọi nhóm admin tự tạo
-- CỐ Ý không được bật: nhập hàng loạt là thao tác sinh ra hàng trăm khách một lúc và
-- ghi đè địa bàn, để mặc định mở là mời tai nạn. Ai cần thì admin tự tick trong ma trận.
