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
export class Permissions {
  constructor(private readonly grants: PermissionGrant[]) {}

  /** Có quyền trên toàn nhà xe, hoặc trên chi nhánh / phòng vé chỉ định. */
  has(perm: string, branchId?: string | null, officeId?: string | null): boolean {
    return this.grants.some(
      (g) =>
        g.permission_code === perm &&
        (g.scope_type === 'tenant' ||
          (g.scope_type === 'branch' && !!branchId && g.scope_id === branchId) ||
          (g.scope_type === 'ticket_office' && !!officeId && g.scope_id === officeId)),
    );
  }

  /** Có quyền này ở bất kỳ phạm vi nào. */
  hasAnywhere(perm: string): boolean {
    return this.grants.some((g) => g.permission_code === perm);
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
