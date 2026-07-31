import { SetMetadata } from '@nestjs/common';
import { AdminPanelRole } from 'src/admin-panel/enums/admin-panel-role.enum';

export const ADMIN_PANEL_ROLES_KEY = 'admin_panel_roles';
export const AdminPanelRoles = (...roles: AdminPanelRole[]) =>
  SetMetadata(ADMIN_PANEL_ROLES_KEY, roles);