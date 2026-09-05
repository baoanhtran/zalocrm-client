-- Đưa "Nhãn khách hàng" vào ma trận phân quyền.
--
-- Trước đây MỌI endpoint tag đều không có cổng quyền nào (chỉ cần đăng nhập), nên bất kỳ
-- ai kể cả Sale đều tạo/sửa/xoá/gộp được nhãn của cả tổ chức. Từ giờ chúng đi qua
-- resource 'tag'. seedDefaultPermissionGroups() không cập nhật nhóm đã tồn tại, nên phải
-- vá thẳng cột grants ở đây.
--
-- Mọi câu đều có `NOT (grants ? 'tag')` nên chạy lại không đè lên tick admin tự chỉnh.

-- 1) Nhóm hệ thống theo mặc định đã chốt.
UPDATE permission_groups
SET grants = grants || '{"tag":{"access":true,"create":true,"edit":true,"delete":true}}'::jsonb
WHERE is_system = true AND name IN ('Admin', 'Marketing')
  AND NOT (grants ? 'tag');

UPDATE permission_groups
SET grants = grants || '{"tag":{"access":true,"create":true,"edit":true}}'::jsonb
WHERE is_system = true AND name = 'Trưởng phòng'
  AND NOT (grants ? 'tag');

UPDATE permission_groups
SET grants = grants || '{"tag":{"access":true,"create":true}}'::jsonb
WHERE is_system = true AND name = 'Sale Senior'
  AND NOT (grants ? 'tag');

-- Sale cố ý KHÔNG có quyền tag nào: 'access' nghĩa là mở được trang quản lý Nhãn KH.
-- Họ vẫn đọc được danh mục để chọn nhãn vì cổng GET /tags nhận cả contact.access.
UPDATE permission_groups
SET grants = grants || '{"tag":{"access":true}}'::jsonb
WHERE is_system = true AND name = 'CEO'
  AND NOT (grants ? 'tag');

-- 2) Nhóm TỰ TẠO: chưa từng có quyền tag nào để mà giữ (endpoint vốn không kiểm tra gì),
--    nên không thể suy ra ý định của quản trị. Cho quyền ĐỌC theo contact.access để ô chọn
--    nhãn không chết, còn tạo/sửa/xoá thì để admin tự tick — mặc định mở là chép nguyên
--    lỗ hổng cũ sang cơ chế mới.
UPDATE permission_groups
SET grants = grants || '{"tag":{"access":true}}'::jsonb
WHERE is_system = false
  AND grants #> '{contact,access}' = 'true'::jsonb
  AND NOT (grants ? 'tag');
