import { expect, test, type Page } from '@playwright/test';

/** Chọn ngày trên lịch tháng của màn hình Bán vé (sang tháng sau nếu cần) */
async function pickDay(page: Page, iso: string) {
  const [y, m, d] = iso.split('-');
  const btn = page.getByRole('button', { name: `Ngày ${d}/${m}/${y}` });
  if (await btn.count() === 0) await page.getByRole('button', { name: 'Tháng sau' }).click();
  await btn.click();
}

async function login(page: Page, phone: string, password: string) {
  await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
  await page.getByLabel('Số điện thoại', { exact: true }).fill(phone);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
}

test('Khởi tạo → tạo nhà xe → chủ xe tạo chi nhánh, nhân viên → nhân viên đăng nhập đúng quyền', async ({ page }) => {
  await page.goto('/');

  // 1. Khởi tạo lần đầu: tạo Super Admin
  await expect(page.getByRole('heading', { name: 'Khởi tạo hệ thống' })).toBeVisible();
  await page.getByLabel('Email Super Admin').fill('superadmin.ui@gmail.com');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('Super@123');
  await page.getByLabel('Nhập lại mật khẩu').fill('Super@123');
  await page.getByRole('button', { name: 'Tạo Super Admin' }).click();

  // 2. Super Admin tạo nhà xe Thịnh Phát + Chủ nhà xe
  await expect(page.getByRole('heading', { name: 'Tạo nhà xe mới' })).toBeVisible();
  await expect(page.getByLabel('Mã nhà xe (chữ thường, số, gạch ngang)')).toHaveValue('thinh-phat');
  await page.getByLabel('Tên nhà xe').fill('Nhà xe Thịnh Phát');
  await page.getByLabel('Họ tên chủ nhà xe').fill('Chủ Thịnh Phát');
  await page.getByLabel('Số điện thoại chủ nhà xe').fill('0901000001');
  await page.getByLabel('Mật khẩu ban đầu').fill('chu123');
  await page.getByRole('button', { name: 'Tạo nhà xe' }).click();
  await expect(page.getByRole('heading', { name: 'Nhà xe (1)' })).toBeVisible();

  // 2b. Tạo thêm nhà xe B (không cần tạo project / địa chỉ mới)
  await page.getByLabel('Mã nhà xe (chữ thường, số, gạch ngang)').fill('nha-xe-b');
  await page.getByLabel('Tên nhà xe').fill('Nhà xe B');
  await page.getByLabel('Họ tên chủ nhà xe').fill('Chủ nhà xe B');
  await page.getByLabel('Số điện thoại chủ nhà xe').fill('0903000003');
  await page.getByLabel('Mật khẩu ban đầu').fill('chub123');
  await page.getByRole('button', { name: 'Tạo nhà xe' }).click();
  await expect(page.getByRole('heading', { name: 'Nhà xe (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();

  // 3. Chủ nhà xe đăng nhập bằng số điện thoại
  await login(page, '0901000001', 'chu123');
  // Mở app vào thẳng Bán vé; chuyển sang Người dùng
  await page.getByRole('button', { name: 'Người dùng', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Thêm người dùng' })).toBeVisible();

  // 4. Tạo chi nhánh
  await page.getByRole('button', { name: 'Chi nhánh & phòng vé' }).click();
  await page.getByLabel('Mã', { exact: true }).fill('HN');
  await page.getByLabel('Tên', { exact: true }).fill('Hố Nai');
  await page.getByRole('button', { name: 'Thêm chi nhánh' }).click();
  await expect(page.getByRole('heading', { name: 'Chi nhánh (1)' })).toBeVisible();

  // 5. Tạo nhân viên bán vé
  await page.getByRole('button', { name: 'Người dùng' }).click();
  await page.getByLabel('Họ tên', { exact: true }).fill('Nhân viên bán vé');
  await page.getByLabel('Số điện thoại', { exact: true }).fill('0902000002');
  await page.getByLabel('Mật khẩu ban đầu').fill('nv1234');
  await page.getByRole('combobox', { name: /^Nhóm quyền/ }).selectOption({ label: 'Bán vé' });
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByRole('heading', { name: 'Người dùng (2)' })).toBeVisible();
  await expect(page.getByText('Bán vé · Toàn nhà xe')).toBeVisible();
  // Quyền riêng từng người: ô có từ nhóm hiện tích mờ, tích thêm ô riêng rồi lưu (kiêm nhiệm cộng dồn)
  await page.getByRole('button', { name: 'Phân quyền Nhân viên bán vé' }).click();
  await expect(page.getByLabel('Bán vé: Xem')).toBeChecked();
  await expect(page.getByLabel('Bán vé: Xem')).toBeEnabled();
  await page.getByLabel('Báo cáo: Xem').check();
  await page.getByRole('button', { name: 'Lưu quyền Nhân viên bán vé' }).click();
  await expect(page.getByText('Đã lưu quyền của Nhân viên bán vé')).toBeVisible();
  await expect(page.getByText('Quyền riêng · Toàn nhà xe')).toBeVisible();

  // 5b. Cấu hình bán vé: mặc định 5 phút → đổi 7 phút
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await expect(page.getByLabel('Giữ ghế tại quầy (phút)')).toHaveValue('5');
  await page.getByLabel('Giữ ghế tại quầy (phút)').fill('7');
  await page.getByRole('button', { name: 'Lưu cấu hình bán vé' }).click();
  await expect(page.getByText('Đã lưu cấu hình bán vé')).toBeVisible();

  // 5c. Tạo vai trò tùy chỉnh
  await page.getByRole('button', { name: 'Vai trò', exact: true }).click();
  await page.getByLabel('Nhóm mới').fill('Thu ngân');
  await page.getByRole('button', { name: '+ Tạo nhóm' }).click();
  await expect(page.getByText('Đã tạo nhóm Thu ngân')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Thu ngân/ })).toHaveAttribute('aria-selected', 'true');
  // Bảng quyền như app cũ: tích ô, tích cả dòng, rồi lưu
  await page.getByLabel('Người dùng: Xem').check();
  await page.getByLabel('Gửi hàng: tất cả').check();
  await expect(page.getByLabel('Gửi hàng: Xóa')).toBeChecked();
  await page.getByRole('button', { name: 'Lưu quyền nhóm Thu ngân' }).click();
  await expect(page.getByText('Đã lưu quyền nhóm Thu ngân')).toBeVisible();

  // 5e. Tuyến: 3 điểm dừng, tuyến Hố Nai – Vũng Tàu, giá toàn tuyến + giá chặng
  await page.getByRole('button', { name: 'Tuyến', exact: true }).click();
  for (const [code, name, kind] of [['HN', 'BX Hố Nai', 'Bến xe'], ['BR', 'Bà Rịa', 'Điểm đón trả']]) {
    await page.getByLabel('Mã điểm').fill(code);
    await page.getByLabel('Tên điểm').fill(name);
    await page.getByLabel('Loại điểm').selectOption({ label: kind });
    await page.getByRole('button', { name: 'Thêm điểm dừng' }).click();
    await expect(page.getByText(`Đã thêm điểm dừng ${name}`)).toBeVisible();
  }
  await page.getByLabel('Mã tuyến').fill('HN-VT');
  await page.getByLabel('Tên tuyến', { exact: true }).fill('Hố Nai – Vũng Tàu');
  await page.getByRole('button', { name: 'Thêm tuyến' }).click();
  await expect(page.getByRole('heading', { name: 'Tuyến (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Chi tiết' }).click();
  await page.getByRole('button', { name: 'Sửa điểm dừng' }).click();
  await page.getByLabel('Điểm dừng thứ 1').selectOption({ label: 'BX Hố Nai' });
  await page.getByLabel('Điểm dừng thứ 2').selectOption({ label: 'Bà Rịa' });
  await page.getByLabel('Phút từ điểm đầu, điểm 2').fill('60');
  await page.getByRole('button', { name: '+ Thêm điểm' }).click();
  // Điểm chưa có: tạo ngay trong ô chọn điểm của tuyến
  await page.getByLabel('Điểm dừng thứ 3').selectOption({ label: '+ Điểm mới…' });
  await page.getByLabel('Tên điểm mới, điểm 3').fill('BX Vũng Tàu');
  await page.getByLabel('Loại điểm mới, điểm 3').selectOption({ label: 'Bến xe' });
  await page.getByRole('button', { name: 'Tạo điểm' }).click();
  await expect(page.getByText('Đã thêm điểm dừng BX Vũng Tàu')).toBeVisible();
  await expect(page.getByLabel('Điểm dừng thứ 3')).toHaveValue(/.+/);
  await expect(page.getByLabel('Điểm dừng thứ 3').locator('option:checked')).toHaveText('BX Vũng Tàu');
  await page.getByLabel('Phút từ điểm đầu, điểm 3').fill('90');
  await page.getByRole('button', { name: 'Lưu điểm dừng', exact: true }).click();
  await expect(page.getByText('Đã lưu điểm dừng của tuyến')).toBeVisible();
  // Chiều về: điểm dừng đảo ngược, giờ tính lại
  await expect(page.getByText("BX Vũng Tàu → Bà Rịa (+30') → BX Hố Nai (+90')")).toBeVisible();
  await page.getByLabel('Giá toàn tuyến').fill('150000');
  await page.getByRole('button', { name: 'Lưu giá toàn tuyến' }).click();
  await expect(page.getByText('Đã lưu giá toàn tuyến')).toBeVisible();
  await page.getByLabel('Chặng từ').selectOption({ label: 'BX Hố Nai' });
  await page.getByLabel('Chặng đến').selectOption({ label: 'Bà Rịa' });
  await page.getByLabel('Giá chặng').fill('120000');
  await page.getByRole('button', { name: 'Lưu giá chặng' }).click();
  await expect(page.getByText('BX Hố Nai ⇄ Bà Rịa: 120.000 đ')).toBeVisible();

  // 5f. Loại xe giường nằm + vẽ sơ đồ ghế bằng "Tạo nhanh", đánh dấu chỗ ưu tiên
  await page.getByRole('button', { name: 'Xe', exact: true }).click();
  await page.getByLabel('Mã loại xe').fill('GN6');
  await page.getByLabel('Tên loại xe').fill('Giường nằm 6 chỗ');
  await page.getByLabel('Kiểu xe').selectOption({ label: 'Giường nằm' });
  await page.getByLabel('Chỗ ngồi', { exact: true }).fill('1');
  await page.getByLabel('Chỗ nằm', { exact: true }).fill('6');
  await page.getByRole('button', { name: 'Thêm loại xe' }).click();
  await expect(page.getByText('Đã thêm loại xe Giường nằm 6 chỗ')).toBeVisible();
  await page.getByRole('button', { name: 'Sơ đồ ghế', exact: true }).click();
  await page.getByRole('button', { name: 'Sửa sơ đồ' }).click();
  await page.getByLabel('Số hàng', { exact: true }).fill('3');
  await page.getByLabel('Số cột', { exact: true }).fill('3');
  await page.getByLabel('Cột lối đi').fill('2');
  await page.getByRole('button', { name: 'Tạo nhanh' }).click();
  await page.getByRole('button', { name: 'Chỗ ưu tiên' }).click();
  await page.getByRole('button', { name: /^Tầng 1 hàng 1 cột 1/ }).click();
  await page.getByRole('button', { name: 'Lưu sơ đồ' }).click();
  await expect(page.getByText('Đã lưu sơ đồ ghế')).toBeVisible();
  await expect(page.getByText('Sơ đồ: 6 giường · 6 chỗ bán · 1 chỗ ưu tiên')).toBeVisible();

  // 5g. Thêm xe: tải ảnh giấy đăng ký (CI không có AI → báo nhập tay), nhập tay, lưu kèm giấy tờ
  const png = { name: 'giay.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') };
  // ngày theo giờ Việt Nam (UTC+7), không theo giờ UTC của máy chạy kiểm thử
  const ngay = (n: number) => new Date(Date.now() + 7 * 3600000 + n * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('Tải ảnh Đăng ký').setInputFiles(png);
  await expect(page.getByText('Chưa cấu hình AI đọc giấy tờ, vui lòng nhập tay')).toBeVisible();
  await page.getByLabel('Đăng ký: Số đăng ký').fill('012345');
  await page.getByRole('textbox', { name: 'Biển số xe' }).fill('51B-123.45');
  await page.getByRole('combobox', { name: /^Loại xe/ }).selectOption({ label: 'Giường nằm 6 chỗ (GN6)' });
  await page.getByRole('spinbutton', { name: 'Năm sản xuất', exact: true }).fill('2020');
  await page.getByRole('button', { name: 'Lưu xe' }).click();
  await expect(page.getByText('Đã thêm xe 51B-123.45')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Xe (1)', exact: true })).toBeVisible();

  // 5h. Thêm kiểm định sắp hết hạn → cảnh báo; thêm bản mới → bản cũ vào "giấy cũ"
  // Mục Xe giống Lái xe & nhân viên: thẻ theo loại xe, chuông cảnh báo gộp theo xe, ảnh xe
  await expect(page.getByRole('tab', { name: 'Giường nằm 6 chỗ (1)' })).toBeVisible();
  await page.getByRole('button', { name: /^Cảnh báo: \d+ việc cần xử lý của 1 xe$/ }).click();
  await page.getByRole('button', { name: 'Mở hồ sơ xe 51B-123.45' }).click();
  await expect(page.getByRole('dialog', { name: 'Sửa xe 51B-123.45' })).toBeVisible();
  await page.getByLabel('Ảnh xe', { exact: true }).setInputFiles(png);
  await page.getByRole('button', { name: 'Dùng cả ảnh' }).click();
  await expect(page.getByText('Đã lưu ảnh xe', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await expect(page.locator('.veh-card').getByRole('img', { name: 'Ảnh 51B-123.45' })).toBeVisible();
  await page.getByRole('button', { name: 'Sửa xe 51B-123.45' }).click();
  await expect(page.getByRole('dialog', { name: 'Sửa xe 51B-123.45' })).toBeVisible();
  await expect(page.getByText('Số 012345')).toBeVisible();
  await page.getByRole('button', { name: 'Thêm Kiểm định' }).click();
  await page.getByLabel('Tải ảnh Kiểm định').setInputFiles(png);
  await expect(page.getByText('Chưa cấu hình AI đọc giấy tờ, vui lòng nhập tay')).toBeVisible();
  await page.getByLabel('Kiểm định: Có hiệu lực đến').fill(ngay(10));
  await page.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.getByText('Đã lưu Giấy chứng nhận kiểm định (đăng kiểm)')).toBeVisible();
  // Cảnh báo ở chuông (gộp theo xe), bấm biển số mở lại hồ sơ xe
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await page.getByRole('button', { name: /^Cảnh báo: \d+ việc cần xử lý của 1 xe$/ }).click();
  await expect(page.getByText(/Kiểm định: Sắp hết hạn/)).toBeVisible();
  await page.getByRole('button', { name: 'Mở hồ sơ xe 51B-123.45' }).click();
  await page.getByRole('button', { name: 'Thêm Kiểm định' }).click();
  await page.getByLabel('Tải ảnh Kiểm định').setInputFiles(png);
  await page.getByLabel('Kiểm định: Có hiệu lực đến').fill(ngay(200));
  await page.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.getByRole('button', { name: 'Hiện giấy cũ (1)' })).toBeVisible();
  await expect(page.getByText(/Kiểm định: Sắp hết hạn/)).toHaveCount(0);
  // Đọc lại ảnh đã lưu (CI không có AI → báo nhập tay, vẫn mở ô sửa)
  await page.getByRole('button', { name: 'Đọc lại Kiểm định' }).click();
  await expect(page.getByText('Chưa cấu hình AI đọc giấy tờ, vui lòng nhập tay')).toBeVisible();
  await expect(page.getByRole('button', { name: 'AI đọc lại ảnh đã lưu' })).toBeVisible();
  // Bản in lý lịch phương tiện: tự lấy thông tin xe + các lần kiểm định
  await page.getByRole('button', { name: '🖨 Xem / in lý lịch phương tiện' }).click();
  const llpt = page.locator('.paper-top');
  await expect(llpt.getByRole('heading', { name: 'LÝ LỊCH PHƯƠNG TIỆN KINH DOANH VẬN TẢI', exact: true })).toBeVisible();
  await expect(llpt.getByText('51B-123.45/LLPT')).toBeVisible();
  await expect(llpt.getByText('Lần 2', { exact: true })).toBeVisible();
  await llpt.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(llpt).toHaveCount(0);
  // Hợp đồng thuê xe (xe thuê của cá nhân): đổi sang Xe thuê → lập hợp đồng (CCCD chủ xe bổ sung sau) → cấp số …/HĐTX → PDF vào hồ sơ xe
  const dlx = page.getByRole('dialog', { name: 'Sửa xe 51B-123.45' });
  await dlx.getByLabel('Hình thức sử dụng').selectOption({ label: 'Xe thuê' });
  await dlx.getByRole('button', { name: 'Lưu thông tin xe' }).click();
  await expect(page.getByText('Đã lưu thông tin xe')).toBeVisible();
  await dlx.getByRole('button', { name: '+ Lập hợp đồng thuê xe' }).click();
  const hdx = page.getByRole('dialog', { name: 'Lập hợp đồng thuê xe' });
  await hdx.getByLabel('Họ tên chủ xe').fill('Nguyễn Văn Chủ');
  await hdx.getByLabel('Giá thuê xe 51B-123.45').fill('8000000');
  await hdx.getByRole('button', { name: 'Lập & cấp số' }).click();
  await expect(page.getByText(/Đã lưu hợp đồng \d{3}\/\d{4}\/HĐTX/)).toBeVisible({ timeout: 30_000 });
  await expect(dlx.getByText('Hợp đồng thuê xe / hợp tác kinh doanh')).toBeVisible();
  await dlx.getByRole('button', { name: /^Xem hợp đồng \d{3}\/\d{4}\/HĐTX/ }).click();
  await expect(page.locator('.paper-top').getByText('HỢP ĐỒNG THUÊ XE Ô TÔ').first()).toBeVisible();
  await expect(page.locator('.paper-top').getByText(/8\.000\.000 VNĐ\/tháng/).first()).toBeVisible();
  await page.locator('.paper-top').getByRole('button', { name: 'Đóng', exact: true }).click();
  // Sơ đồ ghế trong cửa sổ xe: thêm ô tài xế + cửa lên xuống (không bán, không tính chỗ)
  const dlg = page.getByRole('dialog', { name: 'Sửa xe 51B-123.45' });
  await dlg.getByRole('button', { name: 'Sửa sơ đồ' }).click();
  await dlg.getByLabel('Số hàng', { exact: true }).fill('4');
  await dlg.getByRole('button', { name: 'Tài xế' }).click();
  await dlg.getByRole('button', { name: /^Tầng 1 hàng 4 cột 1/ }).click();
  await dlg.getByRole('button', { name: 'Cửa lên xuống' }).click();
  await dlg.getByRole('button', { name: /^Tầng 1 hàng 4 cột 3/ }).click();
  await expect(dlg.getByRole('button', { name: 'Tầng 1 hàng 4 cột 1: tài xế TX' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Lưu sơ đồ' }).click();
  await expect(page.getByText('Đã lưu sơ đồ ghế').first()).toBeVisible();
  await expect(page.getByText('Sơ đồ: 6 giường · 6 chỗ bán · 1 chỗ ưu tiên')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 5i. Lái xe: tải CCCD mặt trước + mặt sau, nhập tay (CI không có AI), có ngày vào công ty
  await page.getByRole('button', { name: 'Lái xe & nhân viên', exact: true }).click();
  await page.getByLabel('Tải ảnh CCCD – Mặt trước').setInputFiles(png);
  await page.getByLabel('Tải ảnh CCCD – Mặt sau').setInputFiles(png);
  await expect(page.getByText('Chưa cấu hình AI đọc giấy tờ, vui lòng nhập tay')).toBeVisible();
  await page.getByLabel('CCCD: Số CCCD / số định danh cá nhân').fill('079123456789');
  await page.getByLabel('Họ tên', { exact: true }).fill('Nguyễn Văn Tài');
  await page.getByLabel('Ngày vào công ty').fill('2020-03-15');
  await page.getByRole('button', { name: 'Lưu nhân viên' }).click();
  await expect(page.getByText('Đã thêm Nguyễn Văn Tài')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lái xe & nhân viên (1)' })).toBeVisible();
  await expect(page.locator('.staff-card').getByText('GPLX: Chưa có', { exact: true })).toBeVisible();
  // Thẻ chọn theo chức vụ tự sinh từ dữ liệu: Tất cả + Lái xe
  await page.getByRole('tab', { name: 'Lái xe (1)' }).click();
  await expect(page.getByRole('tab', { name: 'Lái xe (1)' })).toHaveAttribute('aria-selected', 'true');
  // Cảnh báo dạng chuông: bấm → danh sách gộp theo từng người
  await page.getByRole('button', { name: /^Cảnh báo: \d+ việc cần xử lý của 1 người$/ }).click();
  await expect(page.getByRole('button', { name: 'Mở hồ sơ Nguyễn Văn Tài' })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await page.getByRole('button', { name: 'Hồ sơ Nguyễn Văn Tài' }).click();
  // Hồ sơ chia thẻ: Thông tin / Giấy tờ / Hợp đồng lao động / Lý lịch hành nghề
  await page.getByRole('tab', { name: /^Giấy tờ/ }).click();
  await expect(page.getByText('Số 079123456789')).toBeVisible();
  // 5j. Hạng bằng theo loại xe + ghi lý lịch hành nghề (vi phạm)
  await expect(page.getByRole('heading', { name: /^Loại xe được lái/ })).toBeVisible();
  await expect(page.getByText(/Giường nằm 6 chỗ.*Chưa có GPLX hoặc chưa nhập hạng/)).toBeVisible();
  await page.getByRole('tab', { name: /^Lý lịch hành nghề/ }).click();
  await page.getByRole('button', { name: 'Thêm vào lý lịch' }).click();
  await page.getByLabel('Vi phạm: Ngày vi phạm').fill(ngay(-30));
  await page.getByLabel('Vi phạm: Hành vi vi phạm').fill('Dừng đỗ sai quy định');
  await page.getByRole('button', { name: 'Lưu lý lịch', exact: true }).click();
  await expect(page.getByText('Đã lưu lý lịch: Vi phạm')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lý lịch hành nghề (1)' })).toBeVisible();
  // Bản in lý lịch hành nghề: tự lấy thông tin lái xe + dòng vi phạm vừa ghi
  await page.getByRole('button', { name: '🖨 Xem / in lý lịch hành nghề' }).click();
  const llhn = page.locator('.paper-top');
  await expect(llhn.getByRole('heading', { name: 'LÝ LỊCH HÀNH NGHỀ NGƯỜI LÁI XE', exact: true })).toBeVisible();
  await expect(llhn.getByText('NGUYỄN VĂN TÀI', { exact: true })).toBeVisible();
  await expect(llhn.getByText('Dừng đỗ sai quy định')).toBeVisible();
  await llhn.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(llhn).toHaveCount(0);
  // 5j2. Chữ ký lái xe trong hồ sơ (đang mở trong cửa sổ): chọn ảnh → khung cắt hiện trên cùng → lưu → ảnh chữ ký hiện trong hồ sơ
  await page.getByRole('tab', { name: 'Thông tin', exact: true }).click();
  await page.getByLabel('Ảnh chữ ký', { exact: true }).setInputFiles({ name: 'chu-ky-lx.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAASwAAACgCAIAAAA5GsY1AAABQ0lEQVR42u3dwRHAIAhFwW8m/bdMqsCMuFuAB5x3hQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOM3qe7qqzJdRtayWXh6ThX+JEEQIIgRECCIERAgiBEQIIgRECCIERAgiBEQIIgRECCIERAgiBEQIIgRECCIERAgiBEQIIgRECNl5s6XV69tQmghhfmkiRGkiRGlxglaEKE2EKM1ZdRGiNBGiNESoNKWJEKUhQqUpTYQoDREqDREqTWmIUGmIUGmIEKUhQqUhQqUpDREqDRHeQGmIUGkwJUKlEXtHFQiW/4IIARGCCAERgggBEYIIARGCCAERgggBEYIIARGCCAERgggBEYIIARGCCAERgggBEYIIARECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAf6eBC0PFch8MAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByRole('img', { name: 'Ảnh cần cắt' })).toBeVisible();
  await page.getByRole('button', { name: 'Dùng cả ảnh' }).click();
  await expect(page.getByText('Đã lưu chữ ký', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Chữ ký', exact: true })).toBeVisible();
  await expect(page.getByText('Chữ ký này đã có sẵn họ tên', { exact: false })).toBeVisible();
  // 5j3. Ảnh đại diện: tải trong hồ sơ → hiện trong hồ sơ và trên thẻ của lái xe
  await page.getByLabel('Ảnh đại diện', { exact: true }).setInputFiles({ name: 'anh.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAASwAAACgCAIAAAA5GsY1AAABQ0lEQVR42u3dwRHAIAhFwW8m/bdMqsCMuFuAB5x3hQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOM3qe7qqzJdRtayWXh6ThX+JEEQIIgRECCIERAgiBEQIIgRECCIERAgiBEQIIgRECCIERAgiBEQIIgRECCIERAgiBEQIIgRECNl5s6XV69tQmghhfmkiRGkiRGlxglaEKE2EKM1ZdRGiNBGiNESoNKWJEKUhQqUpTYQoDREqDREqTWmIUGmIUGmIEKUhQqUhQqUpDREqDRHeQGmIUGkwJUKlEXtHFQiW/4IIARGCCAERgggBEYIIARGCCAERgggBEYIIARGCCAERgggBEYIIARGCCAERgggBEYIIARECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAf6eBC0PFch8MAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: 'Dùng cả ảnh' }).click();
  await expect(page.getByText('Đã lưu ảnh đại diện', { exact: true })).toBeVisible();
  await expect(page.locator('.ava-field img.sc-ava')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await expect(page.locator('.staff-card').getByRole('img', { name: 'Ảnh Nguyễn Văn Tài' })).toBeVisible();

  // 5j4. Văn bản: cấp số tự động 001 trở đi, mỗi loại 1 dãy; xem trước bản in
  await page.getByRole('button', { name: 'Văn bản', exact: true }).click();
  await page.getByRole('button', { name: 'Soạn văn bản mới' }).click(); await page.locator('[data-tpl="cong_van"]').click();
  await page.getByLabel('Trích yếu (V/v …)').fill('đăng ký khai thác tuyến');
  await page.getByLabel('Kính gửi (mỗi dòng một nơi)').fill('Sở Xây dựng Đồng Nai');
  await page.getByLabel('Nội dung (mỗi dòng một đoạn)').fill('Công ty xin đăng ký khai thác tuyến.');
  await page.getByLabel('Lưu PDF vào Lưu trữ hồ sơ').uncheck();
  await page.getByRole('button', { name: 'Lưu & cấp số' }).click();
  await expect(page.getByText(/^Đã cấp số 001\/\d{4}\/CV/)).toBeVisible();
  await page.getByRole('button', { name: 'Soạn văn bản mới' }).click(); await page.locator('[data-tpl="qd_bo_nhiem"]').click();
  await page.getByLabel('Người được bổ nhiệm').selectOption({ label: 'Nguyễn Văn Tài' });
  await page.getByLabel('Lưu PDF vào Lưu trữ hồ sơ').uncheck();
  await page.getByRole('button', { name: 'Lưu & cấp số' }).click();
  await expect(page.getByText(/^Đã cấp số 001\/\d{4}\/QĐ/)).toBeVisible();
  await page.getByRole('button', { name: 'Soạn văn bản mới' }).click(); await page.locator('[data-tpl="cong_van"]').click();
  await page.getByLabel('Trích yếu (V/v …)').fill('báo cáo tình hình');
  await page.getByLabel('Lưu PDF vào Lưu trữ hồ sơ').uncheck();
  await page.getByRole('button', { name: 'Lưu & cấp số' }).click();
  await expect(page.getByText(/^Đã cấp số 002\/\d{4}\/CV/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Văn bản (3)' })).toBeVisible();
  await page.getByRole('button', { name: /^Xem văn bản 001\/\d{4}\/QĐ/ }).click();
  const vb = page.locator('.paper-top');
  await expect(vb.getByRole('heading', { name: 'QUYẾT ĐỊNH', exact: true })).toBeVisible();
  await expect(vb.getByText('Về việc bổ nhiệm Người trực tiếp điều hành hoạt động vận tải')).toBeVisible();
  await expect(vb.getByText('NGUYỄN VĂN TÀI', { exact: true })).toBeVisible();
  await vb.getByRole('button', { name: 'Đóng', exact: true }).click();
  // Văn bản tự soạn: mở file Word, ô {…} tự điền theo người được chọn, cấp số chung dãy Quyết định
  await page.getByRole('button', { name: 'Soạn văn bản mới' }).click(); await page.locator('[data-tpl="word_qd"]').click();
  await page.getByLabel('Mở file Word').setInputFiles('e2e/fixtures/van-ban-mau.docx');
  await expect(page.getByRole('textbox', { name: 'Nội dung văn bản' })).toContainText('Về việc khen thưởng {Ông/Bà} {Họ tên}');
  await page.getByLabel('Trích yếu (Về việc …)').fill('Về việc khen thưởng');
  await page.getByLabel('Người liên quan (nếu có)').selectOption({ label: 'Nguyễn Văn Tài' });
  await page.getByLabel('Lưu PDF vào Lưu trữ hồ sơ').uncheck();
  await page.getByRole('button', { name: 'Lưu & cấp số' }).click();
  await expect(page.getByText(/^Đã cấp số 002\/\d{4}\/QĐ/)).toBeVisible();
  await page.getByRole('button', { name: /^Xem văn bản 002\/\d{4}\/QĐ/ }).click();
  await expect(vb.getByText(/Khen thưởng Ông NGUYỄN VĂN TÀI/)).toBeVisible();
  await expect(vb.getByText(/Số: 002\/\d{4}\/QĐ/)).toBeVisible();
  await vb.getByRole('button', { name: 'Đóng', exact: true }).click();
  // QĐ giao nhiệm vụ giám sát ATGT: tự điền người được giao, số chung dãy QĐ, kèm phụ lục
  await page.getByRole('button', { name: 'Soạn văn bản mới' }).click(); await page.locator('[data-tpl="qd_giam_sat"]').click();
  await page.getByLabel('Người được giao nhiệm vụ').selectOption({ label: 'Nguyễn Văn Tài' });
  await page.getByLabel('Lưu PDF vào Lưu trữ hồ sơ').uncheck();
  await page.getByRole('button', { name: 'Lưu & cấp số' }).click();
  await expect(page.getByText(/^Đã cấp số 003\/\d{4}\/QĐ/)).toBeVisible();
  await page.getByRole('button', { name: /^Xem văn bản 003\/\d{4}\/QĐ/ }).click();
  await expect(vb.getByText(/Giao ông: Nguyễn Văn Tài/)).toBeVisible();
  await expect(vb.getByText('PHỤ LỤC 8 – DANH MỤC HỒ SƠ LƯU TRỮ')).toBeVisible();
  await vb.getByRole('button', { name: 'Đóng', exact: true }).click();
  // Đơn xin nghỉ việc + Quyết định thôi việc: tự điền từ hồ sơ, gợi ý ngày nghỉ theo ngày báo trước, sửa tự do, số dãy riêng QĐTV
  await page.getByRole('button', { name: 'Soạn văn bản mới' }).click(); await page.locator('[data-tpl="qd_thoi_viec"]').click();
  await page.getByLabel('Người nghỉ việc').selectOption({ label: 'Nguyễn Văn Tài' });
  await expect(page.getByText('Ngày nghỉ sớm nhất hợp lệ:')).toBeVisible();
  await expect(page.getByLabel(/^Xin nghỉ từ ngày/)).not.toHaveValue('');
  await page.getByLabel('Ghi rõ lý do (nếu cần)').fill('chuyển về quê');
  await page.getByRole('button', { name: '✏️ Sửa tự do đơn' }).click();
  await expect(page.getByRole('textbox', { name: 'Nội dung văn bản' })).toContainText('ĐƠN XIN NGHỈ VIỆC');
  await expect(page.getByRole('textbox', { name: 'Nội dung văn bản' })).toContainText('chuyển về quê');
  await page.getByLabel(/chuyển hồ sơ nhân viên sang/).uncheck();
  await page.getByLabel('Lưu PDF vào Lưu trữ hồ sơ').uncheck();
  await page.getByRole('button', { name: 'Lưu & cấp số' }).click();
  await expect(page.getByText(/^Đã cấp số 001\/\d{4}\/QĐTV/)).toBeVisible();
  await page.getByRole('button', { name: /^Xem văn bản 001\/\d{4}\/QĐTV/ }).click();
  await expect(vb.getByRole('heading', { name: 'ĐƠN XIN NGHỈ VIỆC', exact: true })).toBeVisible();
  await expect(vb.getByText(/Số: 001\/\d{4}\/QĐTV/)).toBeVisible();
  await expect(vb.getByText(/Chấm dứt hợp đồng lao động và giải quyết cho nghỉ việc/)).toBeVisible();
  await vb.getByRole('button', { name: 'Đóng', exact: true }).click();
  // 5j5. Cấu hình › Đóng BHXH & lương chuyển khoản theo tháng: nhập xong tự lưu, mở lại vẫn còn
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await page.getByLabel('Đóng BHXH Nguyễn Văn Tài').check();
  await page.getByLabel('Lương chuyển khoản Nguyễn Văn Tài').fill('7000000');
  await expect(page.getByLabel('Lương chuyển khoản Nguyễn Văn Tài')).toHaveValue('7.000.000');
  await expect(page.locator('.pay-bar').getByText('Đã lưu', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Văn bản', exact: true }).click();
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await expect(page.getByLabel('Lương chuyển khoản Nguyễn Văn Tài')).toHaveValue('7.000.000');
  await expect(page.getByLabel('Đóng BHXH Nguyễn Văn Tài')).toBeChecked();
  // Sao lưu & khôi phục (Chủ nhà xe): tải file .json.gz rồi khôi phục lại từ chính file đó (dữ liệu đủ: không thêm dòng nào)
  const slDl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải bản sao lưu về máy' }).click();
  const slFile = await (await slDl).path();
  await expect(page.getByText(/^Đã tải bản sao lưu: [\d.]+ dòng dữ liệu/)).toBeVisible();
  await page.getByLabel('Chọn file sao lưu').setInputFiles(slFile!);
  await page.getByRole('dialog').getByRole('button', { name: 'Khôi phục', exact: true }).click();
  await expect(page.getByText('Dữ liệu đang đủ, không có dòng nào cần khôi phục')).toBeVisible({ timeout: 60000 });
  // 5j5b. Bảng chấm công (như app cũ): lái xe chưa có chuyến nằm ở nhóm "Lái xe chưa có lịch chạy", Lương CK lấy từ bảng tháng
  await page.getByRole('button', { name: 'Bảng chấm công', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Bảng chấm công tháng/ })).toBeVisible();
  await expect(page.locator('table.cc').getByText('Lái xe chưa có lịch chạy')).toBeVisible();
  await expect(page.locator('table.cc tr', { hasText: 'Nguyễn Văn Tài' }).getByText('7.000.000')).toBeVisible();
  // 5j5c. Giám sát ATGT: ghi sự việc, đóng là vi phạm (tự ghi lý lịch lái xe), báo cáo tháng tự tổng hợp
  await page.getByRole('button', { name: 'Giám sát ATGT', exact: true }).click();
  await page.getByRole('button', { name: '+ Ghi sự việc' }).click();
  await page.getByLabel('Lái xe liên quan').selectOption({ label: 'Nguyễn Văn Tài' });
  await page.getByLabel('Nội dung sự việc').fill('Vượt tốc độ 92/80 km/h trên QL51');
  await page.getByRole('button', { name: 'Ghi vào sổ' }).click();
  await expect(page.getByText('Đã ghi vào sổ giám sát')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng sự việc Vượt tốc độ 92/80 km/h trên QL51' }).click();
  await page.getByLabel('Kết luận').selectOption('vi_pham');
  await page.getByRole('button', { name: 'Đóng sự việc', exact: true }).click();
  await expect(page.getByText('Đã đóng · đã ghi Lý lịch hành nghề lái xe')).toBeVisible();
  await page.getByRole('button', { name: 'Báo cáo tháng' }).click();
  const bc = page.locator('.paper-top');
  await expect(bc.getByText(/BÁO CÁO GIÁM SÁT AN TOÀN THÁNG/)).toBeVisible();
  await expect(bc.getByText(/BẢNG TỔNG HỢP VI PHẠM\/CẢNH BÁO/)).toBeVisible();
  await bc.getByRole('button', { name: 'Đóng', exact: true }).click();
  // 5j5d. Nhiên liệu: giá Petrolimex, nhập bồn tự lưu + in phiếu 80mm, in sổ
  await page.getByRole('button', { name: 'Nhiên liệu', exact: true }).click();
  await expect(page.getByText('Giá bán lẻ Petrolimex vùng 1')).toBeVisible();
  await page.getByRole('button', { name: '+ Nhập bồn' }).click();
  await page.getByLabel('Số lít').fill('1000');
  await page.getByLabel(/^Đơn giá/).fill('25000');
  await page.getByRole('button', { name: 'Lưu & in phiếu 80mm' }).click();
  await expect(page.getByText('PHIẾU NHẬP DẦU')).toBeVisible();
  await page.locator('.lenh-overlay').getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('button', { name: 'In sổ' }).click();
  await expect(page.locator('.paper-top').getByText('SỔ NHẬP XUẤT NHIÊN LIỆU', { exact: true })).toBeVisible();
  await page.locator('.paper-top').getByRole('button', { name: 'Đóng', exact: true }).click();
  // 5j6. Hợp đồng lao động: lập HĐ, số 001 tự cấp, lương lấy từ lương chuyển khoản của tháng bắt đầu (sửa được), xem bản in
  const thang = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);
  await page.getByRole('button', { name: 'Hợp đồng lao động', exact: true }).click();
  await page.getByRole('button', { name: 'Lập HĐ Nguyễn Văn Tài' }).click();
  await page.getByLabel('Từ ngày', { exact: true }).fill(`${thang}-01`);
  await page.getByRole('button', { name: 'Lấy lại' }).click();
  await expect(page.getByLabel('Lương ghi trên hợp đồng')).toHaveValue('7.000.000');
  await page.getByRole('button', { name: 'Lập & cấp số' }).click();
  await expect(page.getByText(/^Đã lập hợp đồng số 001\/\d{4}\/HĐLĐ/)).toBeVisible();
  await page.getByRole('button', { name: 'Xem HĐ Nguyễn Văn Tài' }).click();
  const hd = page.locator('.paper-top');
  await expect(hd.getByText('NGƯỜI LAO ĐỘNG (BÊN B):')).toBeVisible();
  await expect(hd.getByText(/7\.000\.000 đồng\/tháng/).first()).toBeVisible();
  await expect(hd.getByText(/PHỤ LỤC II/)).toBeVisible();
  await hd.getByRole('button', { name: 'Đóng', exact: true }).click();
  // Hợp đồng lao động ngay trong hồ sơ Lái xe & nhân viên: thấy HĐ đã lập, xem trước được
  await page.getByRole('button', { name: 'Lái xe & nhân viên', exact: true }).click();
  await page.getByRole('button', { name: 'Hồ sơ Nguyễn Văn Tài' }).click();
  await page.getByRole('tab', { name: /^Giấy tờ/ }).click();
  await expect(page.getByRole('heading', { name: 'Hợp đồng lao động (1)' })).toBeVisible();
  await page.getByRole('button', { name: /^Xem HĐ 001\/\d{4}\/HĐLĐ/ }).click();
  await expect(page.locator('.paper-top').getByText('NGƯỜI LAO ĐỘNG (BÊN B):')).toBeVisible();
  await page.locator('.paper-top').getByRole('button', { name: 'Đóng', exact: true }).click();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();

  // 5k. Điều hành: thêm nốt 07:00 → tự tạo chuyến; xếp xe + lái xe (có cảnh báo → ghi lý do)
  await page.getByRole('button', { name: 'Điều hành', exact: true }).click();
  // Nhập lịch dán từ Vexere: đọc tuyến / giờ / xe / lái xe, xem trước (chưa có chuyến → tạo chuyến mới), không áp dụng
  await page.getByRole('button', { name: '⇪ Nhập lịch Vexere / Excel' }).click();
  const vxDay = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' });
  await page.getByLabel('Nội dung dán từ Vexere').fill(`ĐHX\n${vxDay}\nHố Nai - Vũng Tàu\nChọn loại xe\n1 Chuyến (0 Hủy)\n07:00\n51B-123.45\nNGUYỄN VĂN TÀI\n0% (0 vé: 0 ĐC, 0 T.t, 0 T)\tChưa XB\n`);
  await expect(page.getByText(/Đọc được 1 chuyến, 1 tuyến/)).toBeVisible();
  await expect(page.getByText('Tạo chuyến mới', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await page.getByLabel('Tuyến lịch chạy').selectOption({ label: 'Hố Nai – Vũng Tàu' });
  await page.getByLabel('Giờ xuất bến').fill('07:00');
  await page.getByRole('button', { name: 'Thêm giờ chạy' }).click();
  await page.getByRole('button', { name: 'Lưu lịch chạy' }).click();
  await expect(page.getByText('Đã lưu lịch chạy: 1 giờ, tạo 8 chuyến')).toBeVisible();
  await page.getByRole('button', { name: 'Xếp xe 07:00 Hố Nai – Vũng Tàu' }).click();
  await page.getByRole('combobox', { name: /^Xe/ }).selectOption({ label: '51B-123.45' });
  await page.getByRole('combobox', { name: /^Lái xe 1/ }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Lưu xếp xe' }).click();
  await expect(page.getByText('Cần lưu ý trước khi xếp:')).toBeVisible();
  await page.getByLabel('Lý do vẫn xếp').fill('Đang bổ sung giấy tờ');
  await page.getByRole('button', { name: 'Vẫn lưu' }).click();
  await expect(page.getByText('Đã xếp xe cho chuyến')).toBeVisible();
  await expect(page.getByText('Đủ xe + lái', { exact: true })).toBeVisible();
  // Vexere: giờ không có tài xế → áp dụng là xóa chuyến; bản dán sau có tài xế → khôi phục và cập nhật lại
  await page.getByRole('button', { name: '⇪ Nhập lịch Vexere / Excel' }).click();
  await page.getByLabel('Nội dung dán từ Vexere').fill(`ĐHX\n${vxDay}\nHố Nai - Vũng Tàu\nChọn loại xe\n1 Chuyến (0 Hủy)\nĐổi giờ07:00\nChuyến bán véChuyến chở hàng\nGhế ngồi 14 chỗ\n0% (0 vé: 0 ĐC, 0 T.t, 14 T)\tChưa XB\n`);
  await expect(page.getByText('Không có tài xế: sẽ xóa chuyến này', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^✔ Áp dụng các dòng đã chọn/ }).click();
  await expect(page.getByText(/xóa 1 chuyến không có tài xế/)).toBeVisible();
  await page.getByLabel('Nội dung dán từ Vexere').fill(`ĐHX\n${vxDay}\nHố Nai - Vũng Tàu\nChọn loại xe\n1 Chuyến (0 Hủy)\nĐổi giờ07:00\nChuyến bán véChuyến chở hàng\nVị trí xe\n51B-123.45\nGhế ngồi 14 chỗ\nNGUYỄN VĂN TÀI\n0% (0 vé: 0 ĐC, 0 T.t, 14 T)\tChưa XB\n`);
  await expect(page.getByText('Chuyến đã xóa trước đó, nay có tài xế: khôi phục và cập nhật', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^✔ Áp dụng các dòng đã chọn/ }).click();
  await expect(page.getByText(/khôi phục 1 chuyến/)).toBeVisible();
  await page.getByRole('button', { name: 'Đóng cửa sổ' }).click();
  await expect(page.getByText('Đủ xe + lái', { exact: true })).toBeVisible();

  // 5l. In lệnh vận chuyển: cấu hình hậu tố TGTP, bấm "In lệnh" → bản in đúng mẫu, số lệnh theo quy ước
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await page.getByLabel('Tên pháp lý (theo đăng ký kinh doanh)').fill('Công ty TNHH MTV Tường Gia Thịnh Phát');
  await page.getByLabel('Số CCCD giám đốc').fill('031073026942');
  await page.getByLabel('Số GPKD vận tải').fill('1265/GPKDVT');
  await page.getByLabel('Ảnh Chữ ký giám đốc').setInputFiles(png);
  await page.getByRole('button', { name: 'Dùng cả ảnh' }).click();
  await expect(page.getByText('Đã lưu ảnh')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bỏ ảnh' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Lưu thông tin công ty' }).click();
  await expect(page.getByText('Đã lưu thông tin công ty')).toBeVisible();
  await page.getByLabel('Hậu tố số lệnh (viết tắt công ty)').fill('TGTP');
  await page.getByLabel('Họ tên người ký lệnh').fill('Hà Văn Thịnh');
  await page.getByRole('button', { name: 'Lưu cấu hình lệnh vận chuyển' }).click();
  await expect(page.getByText('Đã lưu cấu hình lệnh vận chuyển')).toBeVisible();
  await page.getByRole('button', { name: 'Điều hành', exact: true }).click();
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', { name: 'In lệnh 07:00 Hố Nai – Vũng Tàu' }).click();
  await expect(page.getByRole('heading', { name: 'LỆNH VẬN CHUYỂN' })).toBeVisible();
  await expect(page.getByText(/Số: 0700-\d{6}\/LVC-TGTP/)).toBeVisible();
  await expect(page.locator('.lenh').getByText('51B-123.45')).toBeVisible();
  await expect(page.locator('.lenh').getByText('CÔNG TY TNHH MTV TƯỜNG GIA THỊNH PHÁT')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(page.getByText(/Lệnh số 0700-\d{6}\/LVC-TGTP/)).toBeVisible();

  // 5m. Bán vé: gắn loại xe cho nốt → bán vé ngày mai ghế A01, thu tiền mặt, in vé, danh sách khách
  await page.getByRole('button', { name: 'Điều hành', exact: true }).click();
  await page.getByLabel('Tuyến lịch chạy').selectOption({ label: 'Hố Nai – Vũng Tàu' });
  await page.getByLabel('Loại xe nốt 07:00').selectOption({ label: 'Giường nằm 6 chỗ' });
  await page.getByRole('button', { name: 'Lưu lịch chạy' }).click();
  await expect(page.getByText('Đã lưu lịch chạy: 1 giờ, tạo 0 chuyến')).toBeVisible();
  await page.getByRole('button', { name: 'Bán vé', exact: true }).click();
  await pickDay(page, ngay(1));
  await page.getByRole('button', { name: 'Chuyến 07:00 Hố Nai – Vũng Tàu' }).click();
  await page.getByRole('button', { name: 'Ghế A01 trống' }).click();
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByRole('heading', { name: 'Đơn vé · 1 ghế · 150.000 đ' })).toBeVisible();
  await page.getByLabel('Số điện thoại khách').fill('0912345678');
  await page.getByLabel('Tên khách').fill('Chị Lan');
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', { name: 'Thu tiền + in vé' }).click();
  await expect(page.getByText(/Đã bán vé [A-Z0-9]{6} · thu 150\.000 đ/)).toBeVisible();
  await expect(page.getByText('VÉ XE KHÁCH')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(page.getByText(/Tôi thu hôm nay: tiền mặt 150\.000 đ/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ghế A01 trống' })).toHaveCount(0);
  // Điện thoại 390px: màn Bán vé không tràn ngang, sơ đồ ghế vừa màn hình
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Sơ đồ ghế' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const seatBox = (await page.getByRole('button', { name: 'Ghế A02 trống' }).boundingBox())!;
  expect(seatBox.x + seatBox.width).toBeLessThanOrEqual(390);
  // sơ đồ ghế trải gần hết bề ngang màn hình (không co về một nửa)
  const grid = (await page.locator('.vx-seats').first().boundingBox())!;
  expect(grid.width).toBeGreaterThan(300);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('tab', { name: /^Hành khách/ }).click();
  await expect(page.getByText('Chị Lan')).toBeVisible();
  // Gửi hàng: chọn tuyến / chuyến như Bán vé, điểm gửi – nhận theo thứ tự tuyến, xem trước và in phiếu K80
  await page.getByRole('button', { name: 'Gửi hàng', exact: true }).click();
  // ô Tuyến luôn có đủ tuyến (kể cả ngày chưa có chuyến)
  await expect(page.getByLabel('Tuyến', { exact: true }).locator('option', { hasText: 'Vũng Tàu – Hố Nai' })).toHaveCount(1);
  await pickDay(page, ngay(1));
  await page.getByRole('button', { name: 'Chuyến 07:00 Hố Nai – Vũng Tàu' }).click();
  await expect(page.locator('.gh-cur')).toContainText('07:00');
  expect(await page.getByLabel('Gửi tại').inputValue()).not.toBe('');
  expect(await page.getByLabel('Nhận tại').inputValue()).not.toBe('');
  await page.getByLabel('SĐT người gửi', { exact: true }).fill('0911111111');
  await page.getByLabel('SĐT người nhận', { exact: true }).fill('0922222222');
  await page.getByLabel('Hàng gì').fill('1 thùng trái cây');
  await page.getByLabel('Cước (đồng)').fill('30000');
  const pv = page.getByRole('complementary', { name: 'Xem trước phiếu K80' });
  await expect(pv).toContainText('PHIẾU GỬI HÀNG');
  await expect(pv).toContainText('1 thùng trái cây');
  await expect(pv).toContainText('07:00');
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', { name: 'Nhận hàng + in K80' }).click();
  await expect(page.getByText(/^Đã nhận hàng, phiếu /)).toBeVisible();
  await expect(page.locator('.ve-list').getByText('PHIẾU GỬI HÀNG')).toBeVisible();
  // In nhiệt: mỗi phiếu 1 trang khổ 80mm dài đúng bằng nội dung (không in cả trang A4 / 297mm)
  await page.getByRole('button', { name: 'In lại' }).click();
  const pg = await page.evaluate(() => [...document.querySelectorAll('style')].map((x) => x.textContent ?? '').join('').match(/@page tpg0\{size:(\d+)mm (\d+)mm/));
  expect(pg?.[1]).toBe('80');
  expect(Number(pg?.[2])).toBeGreaterThan(60);
  expect(Number(pg?.[2])).toBeLessThan(260);
  const pdf = (await page.pdf({ preferCSSPageSize: true })).toString('latin1');
  const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  console.log('Trang in phiếu gửi hàng (pt):', JSON.stringify(boxes));
  expect(boxes.length).toBe(1);                                   // 1 phiếu = 1 trang, không trang trắng
  expect(Math.round(boxes[0]![0]! / 72 * 25.4)).toBe(80);         // rộng 80mm
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(page.getByRole('button', { name: /^In phiếu / })).toHaveCount(1);

  // 5n. Chuyển khoản QR, nhân viên xác nhận thủ công
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Đọc lại Giấy phép kinh doanh vận tải' })).toBeDisabled();   // chưa có ảnh

  // 5m2. Nhập dữ liệu từ app cũ (file sao lưu .json): xem trước → nhập → nhập lại không trùng; khóa trong file bị bỏ qua
  const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const backup = { buffer: Buffer.from(JSON.stringify({
    _app: 'nhaxe', settings: { ai: { key: 'KHONG-DUOC-LUU' } },
    employees: [{ id: 'e1', ma: 'NV001', ten: 'Lê Văn Cũ', sdt: '0911 222 333', ngayVao: '2019-05-01', gioiTinh: 'Nam', trangThai: 'Đang làm',
                  cccd: '012345678901', cccdTruoc: `data:image/png;base64,${px}`, bangHang: 'D', bangSo: '790123456789', bangHetHan: '2030-01-01' }],
    vehicles: [{ id: 'v1', bks: '60B-999.99', loai: 'Hyundai', soCho: 6, kdSo: 'KD001', hhDangKiem: ngay(300), dangKiem: 'nxdrv:abc' }],
  })), name: 'Sao luu.json', mimeType: 'application/json' };
  await page.getByLabel('File sao lưu app cũ').setInputFiles(backup);
  await expect(page.getByText(/Nhân viên: 1 mới, 0 đã có · 2 giấy tờ/)).toBeVisible();
  await page.getByLabel('Loại xe cho Hyundai 6 chỗ').selectOption({ label: 'Giường nằm 6 chỗ (GN6)' });
  await page.getByRole('button', { name: 'Nhập dữ liệu' }).click();
  await expect(page.getByText('Đã nhập 1 nhân viên, 1 xe, 3 giấy tờ').first()).toBeVisible();
  await page.getByLabel('File sao lưu app cũ').setInputFiles(backup);
  await expect(page.getByText(/Nhân viên: 0 mới, 1 đã có/)).toBeVisible();
  await page.getByRole('button', { name: 'Nhập dữ liệu' }).click();
  await expect(page.getByText('Đã nhập 0 nhân viên, 0 xe, 0 giấy tờ').first()).toBeVisible();
  await page.getByRole('combobox', { name: /^Ngân hàng/ }).selectOption({ label: 'Vietcombank' });
  await page.getByLabel('Số tài khoản').fill('0123456789');
  await page.getByLabel('Tên chủ tài khoản').fill('CONG TY TNHH TUONG GIA THINH PHAT');
  await page.getByRole('button', { name: 'Lưu tài khoản nhận' }).click();
  await expect(page.getByText('Đã lưu tài khoản nhận chuyển khoản')).toBeVisible();
  await page.getByRole('button', { name: 'Bán vé', exact: true }).click();
  await pickDay(page, ngay(1));
  await page.getByRole('button', { name: 'Chuyến 07:00 Hố Nai – Vũng Tàu' }).click();
  await page.getByRole('button', { name: 'Ghế A02 trống' }).click();
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByRole('radio', { name: 'Chuyển khoản (QR)' }).click();
  await page.getByRole('button', { name: 'Tạo QR chuyển khoản' }).click();
  await expect(page.getByAltText('Mã QR chuyển khoản 150.000 đ')).toBeVisible();
  await expect(page.getByText(/^VE [A-Z0-9]{6}$/)).toBeVisible();
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', { name: 'Đã nhận chuyển khoản' }).click();
  await expect(page.getByText(/Đã nhận chuyển khoản vé [A-Z0-9]{6} · 150\.000 đ/)).toBeVisible();
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(page.getByText(/chuyển khoản đã xác nhận 150\.000 đ/)).toBeVisible();

  // 5p. Hủy vé A01 theo mốc phí, hoàn tiền mặt, ghế được nhả
  await page.getByRole('button', { name: 'Ghế A01', exact: true }).click();
  await page.getByRole('button', { name: 'Hủy vé', exact: true }).click();
  await expect(page.getByText(/Phí [\d.]+ đ · hoàn khách [\d.]+ đ/)).toBeVisible();
  await page.getByLabel('Lý do hủy').fill('Khách đổi kế hoạch');
  await page.getByRole('button', { name: 'Xác nhận hủy' }).click();
  await expect(page.getByText(/Đã hủy 1 vé · hoàn [\d.]+ đ · phí [\d.]+ đ/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ghế A01 trống' })).toBeVisible();

  // 5q. Nhập vé giấy: trùng ghế → chờ xếp ghế → xếp sang ghế trống; chặn nhập trùng số vé giấy
  await page.getByRole('button', { name: 'Nhập vé giấy' }).click();
  await page.getByLabel('Số vé giấy').fill('VG001');
  await page.getByLabel('Ghế vé giấy').selectOption('A02');
  await page.getByRole('button', { name: 'Lưu vé giấy' }).click();
  await expect(page.getByText(/Đã nhập vé giấy VG001 nhưng trùng ghế/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vé chờ xếp ghế (1)' })).toBeVisible();
  await page.getByRole('button', { name: /^Ghế A02 · khách/ }).click();
  await page.getByRole('button', { name: 'Chuyển ghế / chuyến' }).click();
  await page.getByLabel('Ghế mới').fill('A01');
  await page.getByRole('button', { name: 'Chuyển', exact: true }).click();
  await expect(page.getByText('Đã chuyển sang ghế A01')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Vé chờ xếp ghế/ })).toHaveCount(0);
  await page.getByLabel('Số vé giấy').fill('VG001');
  await page.getByLabel('Ghế vé giấy').selectOption('A04');
  await page.getByRole('button', { name: 'Lưu vé giấy' }).click();
  await expect(page.getByText(/Vé giấy số VG001 đã nhập rồi/)).toBeVisible();
  await page.getByRole('button', { name: 'Nhập vé giấy' }).click();

  // 5r. Mất mạng: bán trên máy, có mạng tự gửi
  await page.context().setOffline(true);
  await expect(page.getByText(/Mất mạng: đang bán trên máy/)).toBeVisible();
  await page.getByRole('button', { name: 'Ghế A03 trống' }).click();
  await expect(page.getByRole('heading', { name: 'Bán khi mất mạng · 1 ghế' })).toBeVisible();
  await page.getByRole('button', { name: 'Thu tiền, không in' }).click();
  await expect(page.getByText(/Đã bán vé M[A-Z0-9]{5} \(chờ gửi\)/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vé chờ gửi (1)' })).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByText('Đã gửi 1 đơn vé bán khi mất mạng')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Vé chờ gửi/ })).toHaveCount(0);

  // 5r2. Lưu trữ hồ sơ: thêm năm, tạo cây thư mục mẫu, thêm liên kết có hạn (chưa kết nối Drive → không tải tệp được)
  await page.getByRole('button', { name: 'Lưu trữ hồ sơ', exact: true }).click();
  await expect(page.getByText(/Chưa kết nối Google Drive nên chưa tải tệp lên được/)).toBeVisible();
  await page.getByRole('button', { name: '+ Năm' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Thêm năm' }).click();
  await expect(page.getByText(/^Đã thêm năm \d{4}$/)).toBeVisible();
  await page.getByRole('button', { name: 'Tạo cây thư mục mẫu cho nhà xe' }).click();
  await expect(page.getByText('Đã tạo cây thư mục mẫu, đổi tên, thêm, bớt tùy ý')).toBeVisible();
  await page.getByRole('button', { name: '📁 01. Pháp lý công ty' }).first().click();
  await page.getByRole('button', { name: '🔗 Thêm liên kết' }).click();
  const dl = page.getByRole('dialog');
  await dl.getByLabel('Tên hồ sơ').fill('Giấy phép kinh doanh vận tải');
  await dl.getByLabel('Địa chỉ liên kết (Google Drive, website…)').fill('drive.google.com/file/d/abc');
  await dl.getByLabel('Ngày hết hạn (nếu có)').fill(ngay(20));
  await dl.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã thêm liên kết')).toBeVisible();
  await expect(page.getByText(/Còn (19|20) ngày/)).toBeVisible();

  // 5s. Không còn thẻ "Chữ ký của tôi" (chữ ký, ảnh đại diện do quản lý nhân sự cập nhật trong hồ sơ)
  await page.getByRole('button', { name: 'Tài khoản của tôi' }).click();
  await expect(page.getByRole('heading', { name: 'Chữ ký của tôi' })).toHaveCount(0);

  // 5m. Lái xe báo đổ dầu từ app (như app cũ). Thử bằng cách gắn tài khoản chủ vào hồ sơ lái xe Nguyễn Văn Tài:
  // chọn ảnh → (CI không có AI) nhập tay → gửi → Nhiên liệu thấy phiếu chờ duyệt → duyệt thành phiếu đổ ngoài
  await page.getByRole('button', { name: 'Lái xe & nhân viên', exact: true }).click();
  await page.getByRole('button', { name: 'Hồ sơ Nguyễn Văn Tài' }).click();
  await page.getByRole('button', { name: 'Sửa hồ sơ' }).click();
  const hsTai = page.getByRole('dialog', { name: 'Hồ sơ Nguyễn Văn Tài' });
  const acc = hsTai.getByLabel('Tài khoản đăng nhập (nếu có)');
  await acc.selectOption((await acc.locator('option', { hasText: '0901000001' }).getAttribute('value'))!);
  await hsTai.getByRole('button', { name: 'Lưu hồ sơ' }).click();
  await expect(page.getByText(/Đã lưu/).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Việc của tôi', exact: true }).click();
  // App cài được (đã đổi tên + biểu tượng theo ảnh người đăng nhập), Chrome không báo lỗi cài đặt
  const mf = await page.evaluate(async () => { const r = await fetch('/manifest.webmanifest'); return { ct: r.headers.get('content-type'), j: await r.json() }; });
  expect(mf.j.display).toBe('standalone');
  const cdp = await page.context().newCDPSession(page);
  await page.waitForTimeout(3000);
  const inst = await cdp.send('Page.getInstallabilityErrors') as { installabilityErrors: { errorId: string }[] };
  console.log('Lỗi cài app:', JSON.stringify(inst.installabilityErrors), 'manifest:', JSON.stringify(await cdp.send('Page.getAppManifest')).slice(0, 300));
  expect(inst.installabilityErrors.map((x) => x.errorId)).toEqual([]);
  await page.getByRole('button', { name: '⛽ Báo đổ dầu' }).click();
  await page.getByLabel('Chọn ảnh đổ dầu').setInputFiles(png);
  await page.getByRole('button', { name: 'Đọc ảnh & gửi (1 ảnh)' }).click();
  await expect(page.getByText(/AI chưa đọc được/)).toBeVisible();
  await page.getByLabel('Biển số xe').fill('51B-123.45');
  await page.getByLabel('Số lít').fill('50');
  await page.getByLabel('Đơn giá (đ/lít)').fill('27000');
  await page.getByRole('button', { name: 'Gửi điều hành duyệt' }).click();
  await expect(page.getByText('Đã gửi phiếu đổ dầu cho điều hành duyệt')).toBeVisible();
  await expect(page.getByText('Chờ duyệt', { exact: true })).toBeVisible();
  // App lái xe như app cũ: chuyến hôm nay có 3 thẻ Đón khách / Sơ đồ ghế / Trả & hàng; sơ đồ ghế vừa màn hình điện thoại
  // Tất cả chuyến của tôi trong tháng (như app cũ), có dòng chuyến hôm nay
  await expect(page.getByRole('heading', { name: /^Tất cả chuyến của tôi · tháng/ })).toBeVisible();
  await page.getByRole('button', { name: 'Hiện chi tiết chuyến' }).click();
  await expect(page.locator('tr.me-today').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Chuyến 07:00/ })).toBeVisible();
  if (await page.getByRole('tab', { name: 'Sơ đồ ghế' }).count() === 0) await page.getByRole('button', { name: /^Chuyến 07:00/ }).click();
  await expect(page.getByRole('tab', { name: 'Đón khách' })).toBeVisible();
  await expect(page.getByText('Chưa có khách đặt vé.')).toBeVisible();
  await page.getByRole('tab', { name: 'Sơ đồ ghế' }).click();
  await expect(page.getByLabel('Ghế A01 trống')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Trả & hàng' }).click();
  await expect(page.getByText('Không có hàng gửi.')).toBeVisible();
  await page.getByRole('button', { name: 'Nhiên liệu', exact: true }).click();
  const cho = page.getByRole('region', { name: 'Phiếu đổ dầu lái xe gửi chờ duyệt' });
  await expect(cho.getByText('⛽ 1 phiếu đổ dầu lái xe gửi qua app đang chờ duyệt')).toBeVisible();
  await cho.getByRole('button', { name: 'Xem, duyệt' }).click();
  await page.getByRole('button', { name: 'Duyệt, tạo phiếu' }).click();
  await expect(page.getByText('Đã duyệt phiếu đổ dầu của Nguyễn Văn Tài')).toBeVisible();
  await expect(cho).toHaveCount(0);

  // 5d. Nhật ký thao tác ghi lại việc sửa cấu hình
  await page.getByRole('button', { name: 'Nhật ký', exact: true }).click();
  await page.getByLabel('Lọc theo loại').selectOption({ label: 'Cấu hình' });
  await expect(page.getByText('Sửa Cấu hình').first()).toBeVisible();
  await page.getByLabel('Lọc theo loại').selectOption({ label: 'Sơ đồ ghế' });
  await expect(page.getByText('Sửa Sơ đồ ghế').first()).toBeVisible();
  await page.getByRole('button', { name: 'Tài khoản của tôi' }).click();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();

  // 6. Nhân viên đăng nhập: thấy chi nhánh, không có mục Người dùng, không thêm được chi nhánh
  await login(page, '0902000002', 'nv1234');
  await page.getByRole('button', { name: 'Chi nhánh & phòng vé', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chi nhánh (1)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Người dùng' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Thêm chi nhánh' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nhật ký', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tuyến', exact: true }).click();
  await expect(page.getByText('Hố Nai – Vũng Tàu', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm tuyến' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Xe', exact: true }).click();
  await expect(page.getByText('Giường nằm 6 chỗ', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm loại xe' })).toHaveCount(0);
  await expect(page.getByText('51B-123.45').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm xe' })).toHaveCount(0);
  // Nhóm Bán vé không có ô "Lái xe & nhân viên: Xem" → không có mục này; có "Báo cáo: Xem" riêng → có mục Báo cáo
  await expect(page.getByRole('button', { name: 'Lái xe & nhân viên', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Báo cáo', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Điều hành', exact: true }).click();
  await expect(page.getByText('Đủ xe + lái', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu lịch chạy' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Xếp xe/ })).toHaveCount(0);

  // 7. Sai mật khẩu
  await page.getByRole('button', { name: 'Tài khoản của tôi' }).click();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await login(page, '0902000002', 'sai-mat-khau');
  await expect(page.getByText('Sai mã nhà xe, số điện thoại hoặc mật khẩu')).toBeVisible();

  // 8. Chủ nhà xe B đăng nhập cùng địa chỉ bằng mã nhà xe; chỉ thấy dữ liệu nhà xe B
  await page.getByRole('button', { name: 'Đăng nhập nhà xe khác' }).click();
  await page.getByLabel('Mã nhà xe', { exact: true }).fill('nha-xe-b');
  await page.getByLabel('Số điện thoại', { exact: true }).fill('0903000003');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('chub123');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('button', { name: 'Người dùng', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Người dùng (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Tài khoản của tôi' }).click();
  await expect(page.getByText(/^Nhà xe B · Chủ nhà xe B$/)).toBeVisible();
  await page.getByRole('button', { name: 'Chi nhánh & phòng vé' }).click();
  await expect(page.getByRole('heading', { name: 'Chi nhánh (0)' })).toBeVisible();

  // 9. Máy nhớ mã nhà xe: đăng xuất ra vẫn hiện sẵn mã nha-xe-b
  await page.getByRole('button', { name: 'Tài khoản của tôi' }).click();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.getByLabel('Mã nhà xe', { exact: true })).toHaveValue('nha-xe-b');
  // 10. Cài app vào máy (như app cũ): trình duyệt chưa mời cài thì hiện hướng dẫn theo loại máy
  await page.getByRole('button', { name: '📲 Cài app vào máy' }).click();
  await expect(page.getByRole('dialog', { name: /^Cài app/ })).toBeVisible();
  await expect(page.getByText('🤖 Android (Chrome)')).toBeVisible();
  await page.getByRole('dialog', { name: /^Cài app/ }).getByRole('button', { name: 'Đóng', exact: true }).click();
});
