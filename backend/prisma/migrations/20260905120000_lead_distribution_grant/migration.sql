-- Tách quyền "Chia lead tự động" khỏi resource 'settings' thành 'lead_distribution'.
--
-- seedDefaultPermissionGroups() CHỈ tạo nhóm khi chưa có, không bao giờ cập nhật nhóm đã
-- tồn tại. Nên khai resource mới trong code là chưa đủ: nhóm Admin trên server khách đã có
-- từ lâu và sẽ không tự nhận quyền mới, tức là sau khi deploy sẽ không ai sửa được trang
-- này ngoài tài khoản có users.role = owner/admin (vốn bypass toàn bộ ma trận).
--
-- Mọi câu đều có `NOT (grants ? 'lead_distribution')` nên chạy lại không ghi đè lựa chọn
-- mà quản trị viên đã tự tick sau này.

-- 1) Ba nhóm hệ thống theo mặc định đã chốt.
UPDATE permission_groups
SET grants = grants || '{"lead_distribution":{"access":true,"edit":true}}'::jsonb
WHERE is_system = true AND name = 'Admin'
  AND NOT (grants ? 'lead_distribution');

UPDATE permission_groups
SET grants = grants || '{"lead_distribution":{"access":true}}'::jsonb
WHERE is_system = true AND name IN ('CEO', 'Trưởng phòng')
  AND NOT (grants ? 'lead_distribution');

-- 2) Lưới an toàn cho nhóm TỰ TẠO. Ai đang sửa được trang này qua settings.edit thì sau
--    khi tách resource vẫn phải sửa được — mất quyền âm thầm sau một lần deploy là kiểu
--    hỏng không ai truy ra nguyên nhân. Câu 1 chạy trước nên nhóm hệ thống đã có key,
--    câu này không đụng tới chúng nữa.
UPDATE permission_groups
SET grants = grants || '{"lead_distribution":{"access":true,"edit":true}}'::jsonb
WHERE grants #> '{settings,edit}' = 'true'::jsonb
  AND NOT (grants ? 'lead_distribution');
