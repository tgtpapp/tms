import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, phone: string, password: string) {
  await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
  await page.getByLabel('Số điện thoại', { exact: true }).fill(phone);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
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
  await page.getByRole('button', { name: 'Đăng xuất' }).click();

  // 6. Nhân viên đăng nhập: thấy chi nhánh, không có mục Người dùng, không thêm được chi nhánh
  await login(page, '0902000002', 'nv1234');
  await expect(page.getByRole('heading', { name: 'Chi nhánh (1)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Người dùng' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Thêm chi nhánh' })).toHaveCount(0);

  // 7. Sai mật khẩu
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await login(page, '0902000002', 'sai-mat-khau');
  await expect(page.getByText('Sai số điện thoại hoặc mật khẩu')).toBeVisible();
});
