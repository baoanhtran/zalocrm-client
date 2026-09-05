-- Quét nhóm → Khách hàng 2026-09-05.
--
-- Trước đây thành viên quét ra chỉ nằm ở group_members, không có đường nào thành khách
-- hàng, nên lọc "Nguồn khách = Quét nhóm" luôn ra rỗng. Nay nút "Thêm vào khách hàng"
-- sinh Contact với source='quet-nhom' và ghi ngược contact_id vào đây.
--
-- Cột này là thứ giữ cho thao tác đó lặp lại được mà không hỏng:
--   * bấm lần hai trên cùng thành viên → bỏ qua, không tạo khách trùng;
--   * "thêm tất cả" chạy nhiều lượt → mỗi lượt chỉ lấy contact_id IS NULL nên tiến được;
--   * roster hiện chip "Đã thêm" thay vì để sale đoán.
--
-- ON DELETE SET NULL: xoá khách không được xoá mất dòng roster đã quét (dữ liệu quét
-- tốn rate-limit của nick mới có), chỉ cắt liên kết để lần sau thêm lại được.

ALTER TABLE "group_members" ADD COLUMN "contact_id" TEXT;

ALTER TABLE "group_members"
  ADD CONSTRAINT "group_members_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Đếm/lọc "còn thành viên nào chưa thêm vào KH" trong 1 nick.
CREATE INDEX "group_members_zalo_account_id_contact_id_idx"
  ON "group_members"("zalo_account_id", "contact_id");
