import { Injectable } from '@nestjs/common';
import {
  cupomDoResgate,
  idNumerico,
  paramsDeCuponsDaFilial,
  paramsDeCuponsDaOrganizacao,
} from 'src/beneficios/domain/alloyal-consultas';
import {
  mapearCupomDaFilial,
  mapearCupomDaOrganizacao,
  mapearDetalheDoCupom,
} from 'src/beneficios/domain/alloyal-cupons';
import { AlloyalBranchCouponDto } from 'src/beneficios/dto/alloyal-branch-coupon.dto';
import { AlloyalCouponDetailDto } from 'src/beneficios/dto/alloyal-coupon-detail.dto';
import {
  AlloyalCouponOrderResponseDto,
  AlloyalCouponRedeemResponseDto,
} from 'src/beneficios/dto/alloyal-coupon-redeem.dto';
import { AlloyalOrganizationCouponDto } from 'src/beneficios/dto/alloyal-organization-coupon.dto';
import { BaseOrigin } from 'src/config/tenant.config';
import {
  AlloyalGateway,
  SessaoAlloyal,
} from 'src/integrations/alloyal/alloyal.gateway';

/**
 * Cupons e pedidos (resgates) do associado na Alloyal.
 *
 * Os ids chegam como texto (caminho e query da rota) e são convertidos
 * aqui. Nada disto entra em cache: a lista de cupons depende do uso do
 * próprio usuário, e resgatar muda estado na Alloyal.
 */
@Injectable()
export class AlloyalCuponsService {
  constructor(private readonly alloyal: AlloyalGateway) {}

  async cuponsDaOrganizacao(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: string,
    tipoDeUso?: string,
  ): Promise<AlloyalOrganizationCouponDto[]> {
    const cupons = await this.alloyal.listarCuponsDaOrganizacao(
      base,
      sessao,
      idNumerico(organizacaoId),
      paramsDeCuponsDaOrganizacao(tipoDeUso),
    );
    return cupons.map((cupom) => mapearCupomDaOrganizacao(cupom));
  }

  async cuponsDaFilial(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: string,
    filialId: string,
    pagina?: string,
  ): Promise<AlloyalBranchCouponDto[]> {
    const cupons = await this.alloyal.listarCuponsDaFilial(
      base,
      sessao,
      idNumerico(organizacaoId),
      idNumerico(filialId),
      paramsDeCuponsDaFilial(pagina),
    );
    return cupons.map((cupom) => mapearCupomDaFilial(cupom));
  }

  async detalheDoCupom(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: string,
    cupomId: string,
  ): Promise<AlloyalCouponDetailDto> {
    return mapearDetalheDoCupom(
      await this.alloyal.detalharCupom(
        base,
        sessao,
        idNumerico(organizacaoId),
        idNumerico(cupomId),
      ),
    );
  }

  /** Resgate com código: a Alloyal expõe como `GET` na organização. */
  resgatarComCodigo(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    organizacaoId: string,
    cupomId: string,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    return this.alloyal.resgatarCupomComCodigo(
      base,
      sessao,
      idNumerico(organizacaoId),
      cupomDoResgate(cupomId),
    ) as Promise<AlloyalCouponRedeemResponseDto>;
  }

  /** Resgates já feitos pelo usuário. */
  pedidos(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
  ): Promise<AlloyalCouponOrderResponseDto[]> {
    return this.alloyal.listarPedidos(base, sessao) as Promise<
      AlloyalCouponOrderResponseDto[]
    >;
  }

  /** Resgate genérico (`POST /orders` na Alloyal). */
  resgatar(
    base: BaseOrigin,
    sessao: SessaoAlloyal,
    cupomId: string,
  ): Promise<AlloyalCouponRedeemResponseDto> {
    return this.alloyal.resgatarCupom(
      base,
      sessao,
      cupomDoResgate(cupomId),
    ) as Promise<AlloyalCouponRedeemResponseDto>;
  }
}
