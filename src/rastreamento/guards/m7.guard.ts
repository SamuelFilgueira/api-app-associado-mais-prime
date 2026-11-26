import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { segredosIguais } from 'src/infra/auth/comparacao-segura';

@Injectable()
export class M7WebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const signature = request.headers['x-m7-signature'];

    if (!signature) {
      throw new UnauthorizedException('Assinatura M7 não informada');
    }

    if (!segredosIguais(signature, process.env.M7_WEBHOOK_TOKEN)) {
      throw new UnauthorizedException('Assinatura M7 inválida');
    }

    return true;
  }
}
