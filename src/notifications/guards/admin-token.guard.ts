import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const provided = req.headers['x-admin-token'];
    const adminToken = process.env.ADMIN_PANEL_TOKEN;

    if (!adminToken) {
      throw new UnauthorizedException('Token admin nao configurado');
    }

    if (typeof provided !== 'string' || provided !== adminToken) {
      throw new UnauthorizedException('Token admin invalido');
    }

    return true;
  }
}
