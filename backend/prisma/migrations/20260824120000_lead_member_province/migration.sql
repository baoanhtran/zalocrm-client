-- Địa bàn đặt riêng cho từng người trong vòng chia lead.
-- Đè tỉnh suy từ phòng ban; NULL = bám theo phòng ban (hành vi cũ, mặc định).
-- IF NOT EXISTS: chạy lại trên DB đã áp tay không nổ.
ALTER TABLE "lead_distribution_members" ADD COLUMN IF NOT EXISTS "province" TEXT;
