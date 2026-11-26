import { Injectable } from '@nestjs/common';
import { BaseOrigin } from 'src/config/tenant.config';
import { prazosDoCacheHinova } from 'src/config/integracoes.config';
import { CacheService } from 'src/infra/cache/cache.service';
import { SGA_BASE_URL } from 'src/integrations/hinova/hinova.constants';
import { SgaAuthService } from 'src/integrations/hinova/sga-auth.service';

/**
 * Resposta de uma leitura do SGA. Mantém `status`, `statusText` e `data`
 * como o axios devolve — é por eles que os services decidem —, e acrescenta
 * de onde o valor veio e de quando ele é.
 */
export interface RespostaSga<T = unknown> {
  status: number;
  statusText: string;
  data: T;
  /** `origem`: Hinova, agora; `cache`: fresco; `antigo`: vencido, Hinova fora. */
  fonte: 'origem' | 'cache' | 'antigo';
  atualizadoEm: Date;
}

/** Corpo de `POST /listar/boleto-associado-veiculo`. */
export interface FiltroBoletosDoVeiculo {
  codigo_veiculo: number;
  data_vencimento_original_inicial: string;
  data_vencimento_original_final: string;
}

type RespostaCrua = Pick<RespostaSga, 'status' | 'statusText' | 'data'>;

/** A Hinova respondeu, mas não com um resultado de negócio. */
class RespostaIndisponivel extends Error {
  constructor(readonly resposta: RespostaCrua) {
    super(`SGA respondeu HTTP ${resposta.status}`);
  }
}

/**
 * Leituras da Hinova (SGA) que o app repete o tempo todo, com cache.
 *
 * Sem cache, cada abertura do app consultava associado, boletos e produtos
 * por veículo direto na Hinova — que bloqueia o token de base por "extração
 * de dados" quando o volume passa de um limiar que ela não publica.
 *
 * O que entra no cache: só resposta 200 com corpo JSON. Recusa de negócio
 * (406, 4xx), bloqueio e 5xx nunca são guardados — voltam ao chamador como
 * vieram, e a próxima requisição consulta a Hinova de novo.
 *
 * Escritas (gerar boleto, alterar situação) e fluxos que precisam do valor
 * do instante (primeiro acesso, verificação de pagamento) continuam indo
 * direto ao `SgaAuthService`. Quem muda o dado na Hinova chama o
 * `invalidar*` correspondente.
 */
@Injectable()
export class HinovaClient {
  constructor(
    private readonly sgaAuth: SgaAuthService,
    private readonly cache: CacheService,
  ) {}

  /** `GET /associado/buscar/:cpf` — cadastro, situação e veículos. */
  buscarAssociado(base: BaseOrigin, cpf: string): Promise<RespostaSga> {
    const documento = cpf.replace(/\D/g, '');
    return this.ler(
      base,
      chaveAssociado(documento),
      'sga_associado',
      prazosDoCacheHinova().associadoSeg,
      () =>
        this.sgaAuth.executeRequestWithAuth(base, {
          method: 'GET',
          url: `${SGA_BASE_URL}/associado/buscar/${documento}`,
          validateStatus: () => true,
          compartilharEmVoo: true,
        }),
    );
  }

  /** `POST /listar/boleto-associado-veiculo` — boletos de um veículo. */
  listarBoletosDoVeiculo(
    base: BaseOrigin,
    filtro: FiltroBoletosDoVeiculo,
  ): Promise<RespostaSga> {
    return this.ler(
      base,
      chaveBoletos(filtro),
      'sga_boletos',
      prazosDoCacheHinova().boletosSeg,
      () =>
        this.sgaAuth.executeRequestWithAuth(base, {
          method: 'POST',
          url: `${SGA_BASE_URL}/listar/boleto-associado-veiculo`,
          data: filtro,
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true,
          compartilharEmVoo: true,
        }),
    );
  }

  /** `GET /produto-vinculado-veiculo/listar/:codigo` — produtos do veículo. */
  listarProdutosDoVeiculo<T = unknown>(
    base: BaseOrigin,
    codigoVeiculo: string,
  ): Promise<RespostaSga<T>> {
    return this.ler(
      base,
      `sga:produtos:${codigoVeiculo}`,
      'sga_produtos',
      prazosDoCacheHinova().produtosSeg,
      () =>
        this.sgaAuth.executeRequestWithAuth(base, {
          method: 'GET',
          url: `${SGA_BASE_URL}/produto-vinculado-veiculo/listar/${codigoVeiculo}`,
          headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true,
          compartilharEmVoo: true,
        }),
    ) as Promise<RespostaSga<T>>;
  }

  /** Depois de sincronizar cadastro, detectar pagamento ou reativar. */
  invalidarAssociado(base: BaseOrigin, cpf: string): Promise<void> {
    return this.cache.invalidar(base, chaveAssociado(cpf.replace(/\D/g, '')));
  }

  /** Depois de gerar boleto ou detectar pagamento. */
  invalidarBoletos(
    base: BaseOrigin,
    filtro: FiltroBoletosDoVeiculo,
  ): Promise<void> {
    return this.cache.invalidar(base, chaveBoletos(filtro));
  }

  private async ler(
    base: BaseOrigin,
    chave: string,
    recurso: string,
    ttlSeg: number,
    consultar: () => Promise<RespostaCrua>,
  ): Promise<RespostaSga> {
    const agora = (resposta: RespostaCrua): RespostaSga => ({
      status: resposta.status,
      statusText: resposta.statusText,
      data: resposta.data,
      fonte: 'origem',
      atualizadoEm: new Date(),
    });

    if (ttlSeg <= 0) return agora(await consultar());

    try {
      const lido = await this.cache.obter<RespostaCrua>({
        base,
        chave,
        recurso,
        ttlSeg,
        antigoPorSeg: prazosDoCacheHinova().antigoSeg,
        carregar: async () => {
          const resposta = await consultar();
          const crua: RespostaCrua = {
            status: resposta.status,
            statusText: resposta.statusText,
            data: resposta.data,
          };
          // Bloqueio, falha de autenticação e 5xx contam como "Hinova fora":
          // se houver valor vencido dentro da janela, é ele que será servido.
          if (hinovaIndisponivel(crua)) throw new RespostaIndisponivel(crua);
          return crua;
        },
        guardarSe: (resposta) =>
          resposta.status === 200 &&
          resposta.data !== null &&
          typeof resposta.data === 'object',
      });
      return {
        ...lido.valor,
        fonte: lido.fonte,
        atualizadoEm: lido.atualizadoEm,
      };
    } catch (erro) {
      // Sem valor antigo para servir: a resposta da Hinova volta como veio,
      // e o service decide pelo status, como sempre fez.
      if (erro instanceof RespostaIndisponivel) return agora(erro.resposta);
      throw erro;
    }
  }
}

function chaveAssociado(documento: string): string {
  return `sga:associado:${documento}`;
}

function chaveBoletos(filtro: FiltroBoletosDoVeiculo): string {
  return `sga:boletos:${filtro.codigo_veiculo}:${filtro.data_vencimento_original_inicial}:${filtro.data_vencimento_original_final}`;
}

/** 401/403, 5xx ou 2xx sem corpo JSON: não é resposta de negócio. */
function hinovaIndisponivel({ status, data }: RespostaCrua): boolean {
  if (status === 401 || status === 403 || status >= 500) return true;
  return status < 400 && (data === null || typeof data !== 'object');
}
