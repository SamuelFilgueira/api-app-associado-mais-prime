import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { SgaAuthService } from 'src/shared/sga-auth.service';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import { baseTag } from 'src/shared/log.util';
import {
  formatDateBR,
  isSameLocalDate,
  parseDateSga,
} from 'src/shared/date.util';
import { BoletoNotificacaoConfigService } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import {
  SituacaoBoletoSga,
  normalizarCodigoSituacao,
} from 'src/boleto-notificacao/enums/situacao-boleto-sga.enum';
import {
  SgaBoletoPeriodo,
  SgaBoletoPeriodoPagina,
  SgaBoletoPeriodoRequest,
  SgaBoletoPeriodoResultado,
  SgaBoletoVeiculo,
} from 'src/boleto-notificacao/interfaces/sga-boleto-periodo.interface';

/** Limite de segurança contra loop infinito se os metadados vierem incoerentes. */
const MAX_PAGINAS = 2000;

function toNumber(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const texto =
    typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  const parsed = Number(texto);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();
  return '';
}

/**
 * Normaliza chaves do objeto (trim) — a doc do SGA traz `"mostrando "` com
 * espaço no final.
 */
function normalizarChaves(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key.trim()] = value;
  }
  return out;
}

/**
 * Client de POST /listar/boleto-associado/periodo com paginação completa.
 *
 * `inicio_paginacao` é índice de página base-0; o retorno reporta
 * `pagina_corrente` aparentemente em base-1. O loop itera 0..numero_paginas-1
 * e usa múltiplos critérios de parada (metadados, página vazia, total
 * acumulado) para não depender de um único campo.
 */
@Injectable()
export class SgaBoletoPeriodoClient {
  private readonly logger = new Logger(SgaBoletoPeriodoClient.name);

  constructor(
    private readonly sgaAuthService: SgaAuthService,
    private readonly configService: BoletoNotificacaoConfigService,
  ) {}

  /**
   * Lista todos os boletos ABERTOS cujo vencimento original é exatamente a
   * data-alvo (janela de 1 dia), percorrendo todas as páginas.
   */
  async listarAbertosPorVencimentoOriginal(
    tenant: BaseOrigin,
    dataAlvo: Date,
  ): Promise<SgaBoletoPeriodoResultado> {
    const config = this.configService.get();
    const dataAlvoStr = formatDateBR(dataAlvo);
    const tag = `[BOLETO-NOTIF]${baseTag(tenant)}`;

    const mock = this.carregarMock(dataAlvoStr);

    const boletos: SgaBoletoPeriodo[] = [];
    const vistos = new Set<string>();
    let duplicados = 0;
    let totalRegistros = 0;
    let numeroPaginas = 0;
    let pagina = 0;

    while (pagina < MAX_PAGINAS) {
      const body: SgaBoletoPeriodoRequest = {
        data_vencimento_original_inicial: dataAlvoStr,
        data_vencimento_original_final: dataAlvoStr,
        codigo_situacao_boleto: Number(SituacaoBoletoSga.ABERTO),
        quantidade_por_pagina: config.quantidadePorPagina,
        inicio_paginacao: pagina,
      };

      const paginaResultado = mock
        ? this.paginarMock(mock, body)
        : await this.consultarPagina(tenant, body);

      if (pagina === 0) {
        totalRegistros = paginaResultado.totalRegistros;
        numeroPaginas =
          paginaResultado.numeroPaginas > 0
            ? paginaResultado.numeroPaginas
            : Math.ceil(totalRegistros / config.quantidadePorPagina);

        this.logger.log(
          `${tag} vencimento_original=${dataAlvoStr} situacao=ABERTO → total_registros=${totalRegistros} ` +
            `numero_paginas=${numeroPaginas} (quantidade_por_pagina=${config.quantidadePorPagina})`,
        );
      }

      for (const boleto of paginaResultado.boletos) {
        const chave =
          boleto.nossoNumero ||
          `${boleto.codigoAssociado}:${boleto.dataVencimentoOriginal}:${boleto.valorBoleto}`;
        if (vistos.has(chave)) {
          duplicados++;
          continue;
        }
        vistos.add(chave);
        boletos.push(boleto);
      }

      this.logger.debug(
        `${tag} página ${pagina} (pagina_corrente=${paginaResultado.paginaCorrente}, mostrando=${paginaResultado.mostrando}) → ${paginaResultado.boletos.length} boletos, acumulado=${boletos.length}`,
      );

      pagina++;

      // Critérios de parada (qualquer um encerra):
      // 1. cobrimos numero_paginas (base-0: última página é numero_paginas - 1)
      // 2. página veio vazia
      // 3. já acumulamos total_registros
      if (numeroPaginas > 0 && pagina >= numeroPaginas) break;
      if (paginaResultado.boletos.length === 0) break;
      if (totalRegistros > 0 && boletos.length + duplicados >= totalRegistros)
        break;
    }

    if (pagina >= MAX_PAGINAS) {
      this.logger.error(
        `${tag} paginação interrompida no limite de segurança (${MAX_PAGINAS} páginas)`,
      );
    }

    if (duplicados > 0) {
      this.logger.warn(
        `${tag} ${duplicados} boleto(s) repetido(s) entre páginas foram descartados (ordenação instável no SGA?)`,
      );
    }

    return {
      boletos,
      totalRegistros,
      numeroPaginas,
      paginasConsultadas: pagina,
      duplicadosEntrePaginas: duplicados,
      origem: mock ? 'MOCK' : 'SGA',
    };
  }

  private async consultarPagina(
    tenant: BaseOrigin,
    body: SgaBoletoPeriodoRequest,
  ): Promise<SgaBoletoPeriodoPagina> {
    const config = this.configService.get();
    const url = `${config.sgaBaseUrl}/listar/boleto-associado/periodo`;

    const response = await this.sgaAuthService.executeRequestWithAuth<unknown>(
      tenant,
      {
        method: 'POST',
        url,
        data: body,
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000,
        validateStatus: () => true,
      },
    );

    if (response.status !== 200) {
      const detalhe =
        response.data && typeof response.data === 'object'
          ? JSON.stringify(response.data).slice(0, 300)
          : typeof response.data === 'string'
            ? response.data
            : '';
      throw new Error(
        `SGA /listar/boleto-associado/periodo respondeu HTTP ${response.status} (página ${body.inicio_paginacao}): ${detalhe}`,
      );
    }

    return this.parsePagina(response.data);
  }

  /** Parser defensivo do retorno bruto de uma página. */
  parsePagina(raw: unknown): SgaBoletoPeriodoPagina {
    // Alguns endpoints SGA respondem array puro quando não há paginação
    if (Array.isArray(raw)) {
      const boletos = raw
        .map((item) => this.normalizarBoleto(item))
        .filter(Boolean) as SgaBoletoPeriodo[];
      return {
        boletos,
        mostrando: boletos.length,
        numeroPaginas: 1,
        totalRegistros: boletos.length,
        paginaCorrente: 1,
      };
    }

    if (!raw || typeof raw !== 'object') {
      return {
        boletos: [],
        mostrando: 0,
        numeroPaginas: 0,
        totalRegistros: 0,
        paginaCorrente: 0,
      };
    }

    const data = normalizarChaves(raw as Record<string, unknown>);
    const lista = Array.isArray(data.boletos) ? data.boletos : [];
    const boletos = lista
      .map((item) => this.normalizarBoleto(item))
      .filter(Boolean) as SgaBoletoPeriodo[];

    return {
      boletos,
      mostrando: toNumber(data.mostrando, boletos.length),
      numeroPaginas: toNumber(data.numero_paginas, 0),
      totalRegistros: toNumber(data.total_registros, 0),
      paginaCorrente: toNumber(data.pagina_corrente, 0),
    };
  }

  private normalizarBoleto(item: unknown): SgaBoletoPeriodo | null {
    if (!item || typeof item !== 'object') return null;
    const b = item as Record<string, unknown>;

    const codigoAssociadoNum = toNumber(b.codigo_associado, NaN);
    const veiculos = Array.isArray(b.veiculos)
      ? (b.veiculos.filter(
          (v) => v && typeof v === 'object',
        ) as SgaBoletoVeiculo[])
      : [];

    return {
      nossoNumero: toText(b.nosso_numero),
      codigoAssociado: Number.isFinite(codigoAssociadoNum)
        ? codigoAssociadoNum
        : null,
      nomeAssociado: toText(b.nome_associado),
      cpf: toText(b.cpf),
      dataVencimento: toText(b.data_vencimento),
      dataVencimentoOriginal: toText(b.data_vencimento_original),
      codigoSituacaoBoleto: normalizarCodigoSituacao(b.codigo_situacao_boleto),
      situacaoBoleto: toText(b.situacao_boleto),
      valorBoleto: toText(b.valor_boleto),
      mesReferente: toText(b.mes_referente),
      veiculos,
    };
  }

  // ── Mock para desenvolvimento/homologação ─────────────────────────────────

  /**
   * Se BOLETO_NOTIFICACAO_SGA_MOCK_FILE estiver definido, lê os boletos de um
   * JSON local (array de boletos ou objeto `{ boletos: [...] }` no formato do
   * SGA) e simula filtro + paginação em memória.
   */
  private carregarMock(dataAlvoStr: string): SgaBoletoPeriodo[] | null {
    const arquivo = this.configService.get().sgaMockFile;
    if (!arquivo) return null;

    const caminho = path.isAbsolute(arquivo)
      ? arquivo
      : path.resolve(process.cwd(), arquivo);
    let conteudo: unknown;
    try {
      conteudo = JSON.parse(fs.readFileSync(caminho, 'utf8'));
    } catch (error) {
      throw new Error(
        `Não foi possível ler o mock do SGA em ${caminho}: ${error.message}`,
      );
    }

    const pagina = this.parsePagina(conteudo);
    const dataAlvo = parseDateSga(dataAlvoStr);
    const filtrados = pagina.boletos.filter((b) => {
      const vencimento = parseDateSga(b.dataVencimentoOriginal);
      return (
        !!vencimento &&
        !!dataAlvo &&
        isSameLocalDate(vencimento, dataAlvo) &&
        b.codigoSituacaoBoleto === SituacaoBoletoSga.ABERTO
      );
    });

    this.logger.warn(
      `[BOLETO-NOTIF] ⚠️ MOCK SGA ativo (${caminho}): ${filtrados.length}/${pagina.boletos.length} boletos casam com vencimento_original=${dataAlvoStr} e ABERTO`,
    );

    return filtrados;
  }

  private paginarMock(
    todos: SgaBoletoPeriodo[],
    body: SgaBoletoPeriodoRequest,
  ): SgaBoletoPeriodoPagina {
    const inicio = body.inicio_paginacao * body.quantidade_por_pagina;
    const boletos = todos.slice(inicio, inicio + body.quantidade_por_pagina);
    return {
      boletos,
      mostrando: boletos.length,
      numeroPaginas: Math.ceil(todos.length / body.quantidade_por_pagina),
      totalRegistros: todos.length,
      paginaCorrente: body.inicio_paginacao + 1,
    };
  }
}
