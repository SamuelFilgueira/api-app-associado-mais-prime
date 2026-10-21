import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminPanelRoleGuard } from 'src/infra/guards/admin-panel-role.guard';
import { AdminPanelRole } from 'src/infra/enums/admin-panel-role.enum';

function contexto(user: unknown): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminPanelRoleGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: AdminPanelRoleGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new AdminPanelRoleGuard(reflector as unknown as Reflector);
  });

  it('libera rota sem roles declaradas', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(contexto(undefined))).toBe(true);
  });

  it('barra associado comum (role USER)', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminPanelRole.REVISTORIA]);
    expect(() =>
      guard.canActivate(contexto({ userId: 1, role: 'USER' })),
    ).toThrow(ForbiddenException);
  });

  it('barra perfil do painel que não está na rota', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminPanelRole.REVISTORIA]);
    expect(() =>
      guard.canActivate(
        contexto({ userId: 1, role: 'ADMIN', adminRole: 'MARKETING' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('libera perfil do painel listado na rota', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminPanelRole.REVISTORIA]);
    expect(
      guard.canActivate(
        contexto({ userId: 1, role: 'ADMIN', adminRole: 'REVISTORIA' }),
      ),
    ).toBe(true);
  });

  it('libera adminRole ADMIN em qualquer rota', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminPanelRole.COBRANCA]);
    expect(
      guard.canActivate(
        contexto({ userId: 1, role: 'ADMIN', adminRole: 'ADMIN' }),
      ),
    ).toBe(true);
  });

  it('libera token ADMIN legado sem adminRole', () => {
    reflector.getAllAndOverride.mockReturnValue([AdminPanelRole.COBRANCA]);
    expect(guard.canActivate(contexto({ userId: 1, role: 'ADMIN' }))).toBe(
      true,
    );
  });
});
