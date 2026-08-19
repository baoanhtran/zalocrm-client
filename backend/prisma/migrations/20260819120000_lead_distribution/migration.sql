-- Chia lead tự động (2026-08-19) — spec docs/superpowers/specs/2026-08-19-chia-lead-tu-dong-design.md
-- Mô hình PUSH: cron ngày chia lead chưa có chủ theo hạn mức, sau N ngày chưa chốt
-- thì THÊM sale thứ 2 vào chăm cùng. Không dùng chung bảng với Lead Pool (_ee) — đó
-- là mô hình PULL, ghi chung sẽ hỏng số liệu im lặng.
-- Additive hoàn toàn + IF NOT EXISTS → an toàn chạy trên prod đang có dữ liệu.

CREATE TABLE IF NOT EXISTS "lead_distribution_configs" (
  "id"                   TEXT PRIMARY KEY,
  "org_id"               TEXT NOT NULL,
  -- Mặc định TẮT: deploy xong không có gì tự chạy tới khi admin bật.
  "enabled"              BOOLEAN NOT NULL DEFAULT false,
  "daily_quota_per_user" INTEGER NOT NULL DEFAULT 12,
  "co_assign_after_days" INTEGER NOT NULL DEFAULT 14,
  "escalate_after_days"  INTEGER NOT NULL DEFAULT 28,
  "require_phone"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_distribution_configs_org_id_key" ON "lead_distribution_configs" ("org_id");

CREATE TABLE IF NOT EXISTS "lead_distribution_members" (
  "id"          TEXT PRIMARY KEY,
  "org_id"      TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  -- NULL = dùng daily_quota_per_user của org.
  "daily_quota" INTEGER,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_distribution_members_org_id_user_id_key" ON "lead_distribution_members" ("org_id", "user_id");

CREATE TABLE IF NOT EXISTS "lead_assignments" (
  "id"           TEXT PRIMARY KEY,
  "org_id"       TEXT NOT NULL,
  "contact_id"   TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  -- 'primary' (vòng 1) | 'collaborator' (vòng 2)
  "role"         TEXT NOT NULL,
  -- 1 = chia lần đầu, 2 = thêm sale thứ 2. Cố ý không có vòng 3.
  "round"        INTEGER NOT NULL,
  "assigned_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "escalated_at" TIMESTAMP(3)
);
-- 1 người 1 khách đúng 1 dòng — chặn cron chạy lặp tạo bản trùng.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_assignments_contact_id_user_id_key" ON "lead_assignments" ("contact_id", "user_id");
CREATE INDEX IF NOT EXISTS "lead_assignments_org_id_user_id_assigned_at_idx" ON "lead_assignments" ("org_id", "user_id", "assigned_at");
CREATE INDEX IF NOT EXISTS "lead_assignments_org_id_round_assigned_at_idx" ON "lead_assignments" ("org_id", "round", "assigned_at");

-- Foreign keys (DO block vì Postgres không có ADD CONSTRAINT IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_distribution_configs_org_id_fkey') THEN
    ALTER TABLE "lead_distribution_configs" ADD CONSTRAINT "lead_distribution_configs_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_distribution_members_org_id_fkey') THEN
    ALTER TABLE "lead_distribution_members" ADD CONSTRAINT "lead_distribution_members_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_distribution_members_user_id_fkey') THEN
    ALTER TABLE "lead_distribution_members" ADD CONSTRAINT "lead_distribution_members_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_assignments_org_id_fkey') THEN
    ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_assignments_contact_id_fkey') THEN
    ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_contact_id_fkey"
      FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_assignments_user_id_fkey') THEN
    ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
