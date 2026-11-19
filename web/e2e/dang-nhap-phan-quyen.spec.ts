import { expect, test, type Page } from '@playwright/test';

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
  await page.getByRole('combobox', { name: /^Vai trò/ }).selectOption({ label: 'Bán vé' });
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByRole('heading', { name: 'Người dùng (2)' })).toBeVisible();
  await expect(page.getByText('Bán vé · Toàn nhà xe')).toBeVisible();

  // 5b. Cấu hình bán vé: mặc định 5 phút → đổi 7 phút
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await expect(page.getByLabel('Giữ ghế tại quầy (phút)')).toHaveValue('5');
  await page.getByLabel('Giữ ghế tại quầy (phút)').fill('7');
  await page.getByRole('button', { name: 'Lưu cấu hình bán vé' }).click();
  await expect(page.getByText('Đã lưu cấu hình bán vé')).toBeVisible();

  // 5c. Tạo vai trò tùy chỉnh
  await page.getByRole('button', { name: 'Vai trò', exact: true }).click();
  await page.getByLabel('Tên vai trò').fill('Thu ngân');
  await page.getByLabel('Xem người dùng').check();
  await page.getByRole('button', { name: 'Tạo vai trò' }).click();
  await expect(page.getByText('Đã tạo vai trò Thu ngân')).toBeVisible();

  // 5e. Tuyến: 3 điểm dừng, tuyến Hố Nai – Vũng Tàu, giá toàn tuyến + giá chặng
  await page.getByRole('button', { name: 'Tuyến', exact: true }).click();
  for (const [code, name, kind] of [['HN', 'BX Hố Nai', 'Bến xe'], ['BR', 'Bà Rịa', 'Điểm đón trả'], ['VT', 'BX Vũng Tàu', 'Bến xe']]) {
    await page.getByLabel('Mã điểm').fill(code);
    await page.getByLabel('Tên điểm').fill(name);
    await page.getByLabel('Loại điểm').selectOption({ label: kind });
    await page.getByRole('button', { name: 'Thêm điểm dừng' }).click();
    await expect(page.getByText(`Đã thêm điểm dừng ${name}`)).toBeVisible();
  }
  await page.getByLabel('Mã tuyến').fill('HN-VT');
  await page.getByLabel('Tên tuyến').fill('Hố Nai – Vũng Tàu');
  await page.getByRole('button', { name: 'Thêm tuyến' }).click();
  await expect(page.getByRole('heading', { name: 'Tuyến (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Chi tiết' }).click();
  await page.getByRole('button', { name: 'Sửa điểm dừng' }).click();
  await page.getByLabel('Điểm dừng thứ 1').selectOption({ label: 'BX Hố Nai' });
  await page.getByLabel('Điểm dừng thứ 2').selectOption({ label: 'Bà Rịa' });
  await page.getByLabel('Phút từ điểm đầu, điểm 2').fill('60');
  await page.getByRole('button', { name: '+ Thêm điểm' }).click();
  await page.getByLabel('Điểm dừng thứ 3').selectOption({ label: 'BX Vũng Tàu' });
  await page.getByLabel('Phút từ điểm đầu, điểm 3').fill('90');
  await page.getByRole('button', { name: 'Lưu điểm dừng', exact: true }).click();
  await expect(page.getByText('Đã lưu điểm dừng của tuyến')).toBeVisible();
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
  const ngay = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
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
  await page.getByRole('button', { name: 'Giấy tờ', exact: true }).click();
  await expect(page.getByText('Số 012345')).toBeVisible();
  await page.getByRole('button', { name: 'Thêm Kiểm định' }).click();
  await page.getByLabel('Tải ảnh Kiểm định').setInputFiles(png);
  await expect(page.getByText('Chưa cấu hình AI đọc giấy tờ, vui lòng nhập tay')).toBeVisible();
  await page.getByLabel('Kiểm định: Có hiệu lực đến').fill(ngay(10));
  await page.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.getByText('Đã lưu Giấy chứng nhận kiểm định (đăng kiểm)')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Cảnh báo giấy tờ/ })).toBeVisible();
  await expect(page.getByText(/Kiểm định: Sắp hết hạn/)).toBeVisible();
  await page.getByRole('button', { name: 'Thêm Kiểm định' }).click();
  await page.getByLabel('Tải ảnh Kiểm định').setInputFiles(png);
  await page.getByLabel('Kiểm định: Có hiệu lực đến').fill(ngay(200));
  await page.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.getByRole('button', { name: 'Hiện giấy cũ (1)' })).toBeVisible();
  await expect(page.getByText(/Kiểm định: Sắp hết hạn/)).toHaveCount(0);

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
  await expect(page.getByText(/GPLX: Chưa có/)).toBeVisible();
  await page.getByRole('button', { name: 'Hồ sơ Nguyễn Văn Tài' }).click();
  await expect(page.getByText('Số 079123456789')).toBeVisible();
  // 5j. Hạng bằng theo loại xe + ghi lý lịch hành nghề (vi phạm)
  await expect(page.getByRole('heading', { name: /^Loại xe được lái/ })).toBeVisible();
  await expect(page.getByText(/Giường nằm 6 chỗ.*Chưa có GPLX hoặc chưa nhập hạng/)).toBeVisible();
  await page.getByRole('button', { name: 'Thêm vào lý lịch' }).click();
  await page.getByLabel('Vi phạm: Ngày vi phạm').fill(ngay(-30));
  await page.getByLabel('Vi phạm: Hành vi vi phạm').fill('Dừng đỗ sai quy định');
  await page.getByRole('button', { name: 'Lưu lý lịch' }).click();
  await expect(page.getByText('Đã lưu lý lịch: Vi phạm')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lý lịch hành nghề (1)' })).toBeVisible();

  // 5k. Điều hành: thêm nốt 07:00 → tự tạo chuyến; xếp xe + lái xe (có cảnh báo → ghi lý do)
  await page.getByRole('button', { name: 'Điều hành', exact: true }).click();
  await page.getByLabel('Tuyến của nốt').selectOption({ label: 'Hố Nai – Vũng Tàu (HN-VT)' });
  await page.getByLabel('Giờ xuất bến').fill('07:00');
  await page.getByRole('button', { name: 'Thêm nốt' }).click();
  await expect(page.getByText('Đã thêm nốt 07:00, tạo 8 chuyến')).toBeVisible();
  await page.getByRole('button', { name: 'Xếp xe 07:00 Hố Nai – Vũng Tàu' }).click();
  await page.getByRole('combobox', { name: /^Xe/ }).selectOption({ label: '51B-123.45' });
  await page.getByRole('combobox', { name: /^Lái xe 1/ }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Lưu xếp xe' }).click();
  await expect(page.getByText('Cần lưu ý trước khi xếp:')).toBeVisible();
  await page.getByLabel('Lý do vẫn xếp').fill('Đang bổ sung giấy tờ');
  await page.getByRole('button', { name: 'Vẫn lưu' }).click();
  await expect(page.getByText('Đã xếp xe cho chuyến')).toBeVisible();
  await expect(page.getByText('Đủ xe + lái', { exact: true })).toBeVisible();

  // 5l. In lệnh vận chuyển: cấu hình hậu tố TGTP, bấm "In lệnh" → bản in đúng mẫu, số lệnh theo quy ước
  await page.getByRole('button', { name: 'Cấu hình', exact: true }).click();
  await page.getByLabel('Tên pháp lý (theo đăng ký kinh doanh)').fill('Công ty TNHH MTV Tường Gia Thịnh Phát');
  await page.getByLabel('Số CCCD giám đốc').fill('031073026942');
  await page.getByLabel('Số GPKD vận tải').fill('1265/GPKDVT');
  await page.getByLabel('Ảnh Chữ ký giám đốc').setInputFiles(png);
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
  await page.getByLabel('Loại xe nốt 07:00').selectOption({ label: 'Giường nằm 6 chỗ' });
  await expect(page.getByText('Đã đổi loại xe của nốt')).toBeVisible();
  await page.getByRole('button', { name: 'Bán vé', exact: true }).click();
  await page.getByRole('button', { name: 'Ngày sau' }).click();
  await page.getByRole('button', { name: 'Chuyến 07:00 Hố Nai – Vũng Tàu' }).click();
  await page.getByRole('button', { name: 'Ghế A01 trống' }).click();
  await expect(page.getByRole('heading', { name: 'Đơn vé · 1 ghế · 150.000 đ' })).toBeVisible();
  await page.getByLabel('Số điện thoại khách').fill('0912345678');
  await page.getByLabel('Tên khách').fill('Chị Lan');
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', { name: 'Thu tiền + in vé' }).click();
  await expect(page.getByText(/Đã bán vé [A-Z0-9]{6} · thu 150\.000 đ/)).toBeVisible();
  await expect(page.getByText('VÉ XE KHÁCH')).toBeVisible();
  await page.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(page.getByText('Tiền mặt tôi thu hôm nay: 150.000 đ')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ghế A01 trống' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Danh sách khách' }).click();
  await expect(page.getByText('Chị Lan')).toBeVisible();

  // 5d. Nhật ký thao tác ghi lại việc sửa cấu hình
  await page.getByRole('button', { name: 'Nhật ký', exact: true }).click();
  await expect(page.getByText('Sửa Cấu hình').first()).toBeVisible();
  await expect(page.getByText('Sửa Sơ đồ ghế').first()).toBeVisible();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();

  // 6. Nhân viên đăng nhập: thấy chi nhánh, không có mục Người dùng, không thêm được chi nhánh
  await login(page, '0902000002', 'nv1234');
  await expect(page.getByRole('heading', { name: 'Chi nhánh (1)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Người dùng' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Thêm chi nhánh' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cấu hình', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nhật ký', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Tuyến', exact: true }).click();
  await expect(page.getByText('Hố Nai – Vũng Tàu')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm tuyến' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Xe', exact: true }).click();
  await expect(page.getByText('Giường nằm 6 chỗ', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm loại xe' })).toHaveCount(0);
  await expect(page.getByText('51B-123.45').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm xe' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Lái xe & nhân viên', exact: true }).click();
  await expect(page.getByText('Nguyễn Văn Tài', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hồ sơ Nguyễn Văn Tài' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Điều hành', exact: true }).click();
  await expect(page.getByText('Đủ xe + lái', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thêm nốt' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Xếp xe/ })).toHaveCount(0);

  // 7. Sai mật khẩu
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await login(page, '0902000002', 'sai-mat-khau');
  await expect(page.getByText('Sai mã nhà xe, số điện thoại hoặc mật khẩu')).toBeVisible();

  // 8. Chủ nhà xe B đăng nhập cùng địa chỉ bằng mã nhà xe; chỉ thấy dữ liệu nhà xe B
  await page.getByRole('button', { name: 'Đăng nhập nhà xe khác' }).click();
  await page.getByLabel('Mã nhà xe', { exact: true }).fill('nha-xe-b');
  await page.getByLabel('Số điện thoại', { exact: true }).fill('0903000003');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('chub123');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Người dùng (1)' })).toBeVisible();
  await expect(page.getByText('Nhà xe B', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chi nhánh & phòng vé' }).click();
  await expect(page.getByRole('heading', { name: 'Chi nhánh (0)' })).toBeVisible();

  // 9. Máy nhớ mã nhà xe: đăng xuất ra vẫn hiện sẵn mã nha-xe-b
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.getByLabel('Mã nhà xe', { exact: true })).toHaveValue('nha-xe-b');
});
