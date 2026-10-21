import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ListRedemptionsQuery } from 'src/direct-partners/dto/list-redemptions.query';
import { cupomVisivel } from 'src/direct-partners/helpers/direct-partner.helpers';
import { toAdminRedemption } from 'src/direct-partners/mappers/direct-partner.mapper';
import { DirectPartnersRepository } from 'src/direct-partners/repositories/direct-partners.repository';
import { baseTag } from 'src/shared/log.util';

export interface ResgateResultado {
  codigo: string;
  usoUnico: boolean;
  resgatadoEm: Date;
}

/**
 * Resgate / registro de uso de cupom pelo associado (§4.4, §4.5, §6.3) e
 * listagem de resgates para o painel (§5.8).
 */
@Injectable()
export class DirectPartnerRedemptionsService {
  private readonly logger = new Logger(DirectPartnerRedemptionsService.name);

  constructor(private readonly repository: DirectPartnersRepository) {}

  /**
   * - reutilizável: cria um registro a cada chamada e devolve o código;
   * - uso único: primeira vez cria e devolve o código; segunda vez → 409
   *   `CUPOM_JA_UTILIZADO` com `resgatadoEm`.
   * 404 quando o parceiro não está visível na base ou o cupom não está visível.
   */
  async resgatar(params: {
    partnerId: number;
    couponId: number;
    userId: number;
    baseOrigin: string;
  }): Promise<ResgateResultado> {
    const agora = new Date();
    const parceiro = await this.repository.buscarAppPorId({
      id: params.partnerId,
      baseOrigin: params.baseOrigin,
      agora,
    });
    const cupom = parceiro?.coupons.find((c) => c.id === params.couponId);

    if (!parceiro || !cupom || !cupomVisivel(cupom, agora)) {
      throw new NotFoundException('Cupom não encontrado');
    }

    if (!cupom.singleUse) {
      const uso = await this.repository.registrarUso({
        couponId: cupom.id,
        userId: params.userId,
        baseOrigin: params.baseOrigin,
      });
      return {
        codigo: cupom.code,
        usoUnico: false,
        resgatadoEm: uso.redeemedAt,
      };
    }

    const resultado = await this.repository.resgatarUsoUnico({
      couponId: cupom.id,
      userId: params.userId,
      baseOrigin: params.baseOrigin,
    });

    if (!resultado.criado) {
      throw new ConflictException({
        statusCode: 409,
        code: 'CUPOM_JA_UTILIZADO',
        message: 'Este cupom já foi utilizado por você',
        resgatadoEm: resultado.redeemedAt,
      });
    }

    this.logger.log(
      `${baseTag(params.baseOrigin)} cupom de uso único #${cupom.id} resgatado pelo associado #${params.userId}`,
    );
    return {
      codigo: cupom.code,
      usoUnico: true,
      resgatadoEm: resultado.redeemedAt,
    };
  }

  async listarResgates(
    partnerId: number,
    couponId: number,
    query: ListRedemptionsQuery,
  ) {
    const cupom = await this.repository.buscarCupom(partnerId, couponId);
    if (!cupom) throw new NotFoundException('Cupom não encontrado');

    const skip = (query.page - 1) * query.limit;
    const { data, total } = await this.repository.listarResgates({
      couponId,
      baseOrigin: query.baseOrigin,
      skip,
      take: query.limit,
    });

    return {
      data: data.map(toAdminRedemption),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  }
}
