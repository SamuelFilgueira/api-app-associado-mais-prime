import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';
import { PushGateway } from 'src/integrations/expo/push.gateway';
import { mascararTokenPush } from 'src/notifications/domain/push-mensagem';

/** Token de push do usuário: registro pelo app e limpeza de token morto. */
@Injectable()
export class PushTokenService {
  private readonly logger = new Logger(PushTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PushGateway,
  ) {}

  /**
   * Registra o token do aparelho. Contrato da rota: token inválido ou
   * usuário inexistente respondem 200 com `success: false`.
   */
  async registrar(
    userId: number,
    expoPushToken: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.gateway.tokenValido(expoPushToken)) {
      this.logger.warn(
        `[Token] expoPushToken inválido para user ${userId}: ${mascararTokenPush(expoPushToken)}`,
      );
      return { success: false, message: 'Token Expo inválido.' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      return {
        success: false,
        message: `Usuario com ID ${userId} nao encontrado no banco.`,
      };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { expoPushToken },
    });
    return { success: true, message: 'Token Expo registrado com sucesso.' };
  }

  /**
   * O provedor disse que o aparelho não recebe mais push neste token
   * (`DeviceNotRegistered`). Apaga só se o usuário ainda estiver com ESTE
   * token: se ele já registrou outro (reinstalou o app), o novo fica.
   * Devolve se apagou.
   */
  async apagarSeAindaFor(userId: number, tokenMorto: string): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, expoPushToken: tokenMorto },
      data: { expoPushToken: null },
    });
    if (count === 1) {
      this.logger.log(
        `[Token] token morto apagado do user ${userId}: ${mascararTokenPush(tokenMorto)}`,
      );
    }
    return count === 1;
  }
}
