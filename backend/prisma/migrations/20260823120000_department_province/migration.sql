-- Chi nhánh theo địa bàn: mỗi tỉnh/thành đúng một phòng ban.
--
-- Additive hoàn toàn, IF NOT EXISTS ở cả hai lệnh nên chạy lại nhiều lần không nổ.
-- Cột NULL-able và không có default: phòng ban đang tồn tại giữ nguyên province = NULL,
-- nghĩa là "không phải chi nhánh" và không nhận lead theo tỉnh.

ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "province" TEXT;

-- Postgres coi mỗi NULL là một giá trị khác nhau, nên unique này KHÔNG chặn việc có
-- nhiều phòng ban thường (province = NULL) trong cùng org — nó chỉ chặn hai chi nhánh
-- cùng nhận một tỉnh.
CREATE UNIQUE INDEX IF NOT EXISTS "departments_org_id_province_key"
  ON "departments" ("org_id", "province");
