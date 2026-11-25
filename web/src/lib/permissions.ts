import { supabase, withOfflineCopy } from './supabase';

export interface PermissionGrant {
  permission_code: string;
  scope_type: 'tenant' | 'branch' | 'ticket_office';
  scope_id: string | null;
}

/**
 * Bộ kiểm tra quyền phía giao diện – CHỈ để ẩn/hiện nút.
 * Database luôn tự kiểm tra lại (app.has_permission) ở mọi thao tác.
 */
/** Mã quyền cũ (gộp) → các ô mới (màn hình.xem / thêm / sửa / xóa): có 1 ô là đủ. Chỉ dùng phía giao diện để ẩn / hiện. */
const LEGACY: Record<string, string[]> = {
  'ticket.sell': ['sell.add', 'sell.edit', 'sell.delete'], 'parcel.manage': ['parcel.add', 'parcel.edit', 'parcel.delete'],
  'trip.manage': ['trip.add', 'trip.edit', 'trip.delete', 'charter.add', 'charter.edit'], 'route.manage': ['route.add', 'route.edit', 'route.delete'],
  'fare.manage': ['fare.edit'], 'vehicle.manage': ['vehicle.add', 'vehicle.edit', 'vehicle.delete'], 'staff.manage': ['staff.add', 'staff.edit', 'staff.delete'],
  'salary.manage': ['salary.view', 'labor.view'], 'doc.manage': ['doc.view'], 'archive.manage': ['archive.add', 'archive.edit', 'archive.delete'],
  'branch.manage': ['branch.add'], 'office.manage': ['office.add', 'office.edit'], 'user.read': ['user.view'], 'user.manage': ['user.add', 'user.edit'],
  'role.manage': ['role.view'], 'settings.manage': ['settings.view'], 'audit.read': ['audit.view'],
};
const codes = (perm: string) => LEGACY[perm] ?? [perm];

export class Permissions {
  constructor(private readonly grants: PermissionGrant[]) {}

  /** Dấu để so: quyền có đổi không (nhóm vừa được sửa / người vừa được gán nhóm khác) */
  key(): string {
    return this.grants.map((g) => `${g.permission_code}|${g.scope_type}|${g.scope_id ?? ''}`).sort().join(',');
  }

  /** Có quyền trên toàn nhà xe, hoặc trên chi nhánh / phòng vé chỉ định.
   *  Không chỉ định chi nhánh / phòng vé (hiện mục menu, nút chung): có quyền ở bất kỳ phạm vi nào là đủ —
   *  người được gán nhóm theo chi nhánh / phòng vé vẫn thấy màn hình; dữ liệu trong đó database tự lọc theo phạm vi. */
  has(perm: string, branchId?: string | null, officeId?: string | null): boolean {
    if (branchId === undefined && officeId === undefined) return this.hasAnywhere(perm);
    return this.grants.some(
      (g) =>
        codes(perm).includes(g.permission_code) &&
        (g.scope_type === 'tenant' ||
          (g.scope_type === 'branch' && !!branchId && g.scope_id === branchId) ||
          (g.scope_type === 'ticket_office' && !!officeId && g.scope_id === officeId)),
    );
  }

  /** Có quyền này ở bất kỳ phạm vi nào. */
  hasAnywhere(perm: string): boolean {
    return this.grants.some((g) => codes(perm).includes(g.permission_code));
  }
}

export async function loadPermissions(): Promise<Permissions> {
  const grants = await withOfflineCopy('perms', async () => {
    const { data, error } = await supabase.rpc('my_permissions');
    if (error) throw new Error(error.message);
    return (data ?? []) as PermissionGrant[];
  });
  return new Permissions(grants);
}
