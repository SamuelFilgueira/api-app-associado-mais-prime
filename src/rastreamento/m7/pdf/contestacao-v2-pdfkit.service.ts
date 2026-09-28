import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import type { Writable } from 'stream';
import { TENANT } from 'src/config/tenant.config';
import { formatarDataBR } from 'src/shared/date.util';
import {
  HistoricoM7ContestacaoPontoDto,
  HistoricoM7ContestacaoV2CabecalhoDto,
} from '../dto/historico-m7-response.dto';
import {
  formatarDataHora,
  formatarDataHoraContestacao,
} from './historico-pdf-m7.service';

// ---------------------------------------------------------------------------
// Relatório de Rotas Detalhadas (contestação V2) em pdfkit, com streaming.
//
// Substitui o HTML + Puppeteer para este relatório: é uma tabela plana de seis
// colunas e o Chromium só servia para paginar texto — sem conseguir emitir um
// byte antes do fim. Aqui o cabeçalho sai assim que a M7 responde e cada chunk
// de pontos geocodificados vira páginas imediatamente, o que mantém a conexão
// do app (read timeout de 60 s entre bytes) sempre ativa.
// ---------------------------------------------------------------------------

const PAGINA = { largura: 841.89, altura: 595.28 }; // A4 paisagem, em pt
const MARGEM = { topo: 18, base: 18, esquerda: 14, direita: 14 };
const LARGURA_UTIL = PAGINA.largura - MARGEM.esquerda - MARGEM.direita;

const FONTE = 'Helvetica';
const FONTE_NEGRITO = 'Helvetica-Bold';
const FONTE_ITALICO = 'Helvetica-Oblique';

const COR = {
  texto: '#1f2937',
  titulo: '#101010',
  cinza: '#6b7280',
  cinzaClaro: '#9ca3af',
  vermelho: '#FF0000',
  bordaTabela: '#e5e7eb',
  zebra: '#f9fafb',
  cardFundo: '#f3f4f6',
  cardValor: '#111827',
  avisoFundo: '#fffbeb',
  avisoBorda: '#fcd34d',
  avisoTexto: '#92400e',
  branco: '#ffffff',
};

const TABELA = {
  fonte: 8.5,
  alturaCabecalho: 20,
  paddingX: 6,
  paddingY: 4,
  alturaMinimaLinha: 18,
};

/** Larguras fixas; o endereço absorve o restante da largura útil. */
const COLUNAS = [
  { titulo: 'Data', largura: 58 },
  { titulo: 'Hora', largura: 54 },
  { titulo: 'Velocidade', largura: 64 },
  { titulo: 'Endereço', largura: 0 },
  { titulo: 'Latitude', largura: 88 },
  { titulo: 'Longitude', largura: 88 },
];
const INDICE_ENDERECO = 3;
COLUNAS[INDICE_ENDERECO].largura =
  LARGURA_UTIL - COLUNAS.reduce((acc, c) => acc + c.largura, 0);

function carregarLogo(): Buffer | null {
  try {
    return fs.readFileSync(path.resolve(process.cwd(), TENANT.logoPath));
  } catch {
    return null;
  }
}

/**
 * Escritor incremental: `escreverLinhas` pode ser chamado quantas vezes for
 * preciso; cada página fechada é enviada ao destino na hora (`bufferPages: false`).
 */
export class ContestacaoV2PdfWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly dataGeracao: string;
  private readonly encerrado: Promise<void>;
  private y = MARGEM.topo;
  private totalLinhas = 0;

  constructor(
    private readonly cabecalho: HistoricoM7ContestacaoV2CabecalhoDto,
    destino: Writable,
    private readonly logo: Buffer | null,
  ) {
    this.dataGeracao = formatarDataHora(new Date().toISOString());
    this.doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: {
        top: MARGEM.topo,
        bottom: MARGEM.base,
        left: MARGEM.esquerda,
        right: MARGEM.direita,
      },
      bufferPages: false,
      autoFirstPage: true,
      info: {
        Title: `Relatório de Rotas Detalhadas — ${cabecalho.veiculo.placa}`,
        Author: TENANT.reportName,
      },
    });
    this.encerrado = new Promise<void>((resolve, reject) => {
      this.doc.once('end', () => resolve());
      this.doc.once('error', (error: Error) => reject(error));
    });
    this.doc.pipe(destino);

    this.desenharCabecalhoDocumento();
    this.desenharCabecalhoTabela();
  }

  escreverLinhas(pontos: HistoricoM7ContestacaoPontoDto[]): void {
    const doc = this.doc;
    const larguraEndereco =
      COLUNAS[INDICE_ENDERECO].largura - TABELA.paddingX * 2;

    for (const ponto of pontos) {
      const { data, hora } = formatarDataHoraContestacao(ponto.dataGps);
      const vel = Number(ponto.velocidade ?? 0);
      const endereco = ponto.endereco || '—';

      doc.font(FONTE).fontSize(TABELA.fonte);
      const alturaEndereco = doc.heightOfString(endereco, {
        width: larguraEndereco,
      });
      const alturaLinha = Math.max(
        TABELA.alturaMinimaLinha,
        alturaEndereco + TABELA.paddingY * 2,
      );

      if (this.y + alturaLinha > PAGINA.altura - MARGEM.base) {
        this.novaPagina();
        this.desenharCabecalhoTabela();
      }

      const zebra = this.totalLinhas % 2 !== 0;
      if (zebra) {
        doc
          .rect(MARGEM.esquerda, this.y, LARGURA_UTIL, alturaLinha)
          .fill(COR.zebra);
      }

      const celulas = [
        { texto: data, negrito: false, mono: false },
        { texto: hora, negrito: false, mono: false },
        { texto: `${vel} km/h`, negrito: vel > 0, mono: false },
        { texto: endereco, negrito: false, mono: false },
        { texto: ponto.latitude || '—', negrito: false, mono: true },
        { texto: ponto.longitude || '—', negrito: false, mono: true },
      ];

      let x = MARGEM.esquerda;
      celulas.forEach((celula, indice) => {
        const largura = COLUNAS[indice].largura;
        doc
          .lineWidth(0.5)
          .rect(x, this.y, largura, alturaLinha)
          .stroke(COR.bordaTabela);
        doc
          .font(celula.negrito ? FONTE_NEGRITO : FONTE)
          .fontSize(celula.mono ? TABELA.fonte - 0.5 : TABELA.fonte)
          .fillColor(COR.texto)
          .text(celula.texto, x + TABELA.paddingX, this.y + TABELA.paddingY, {
            width: largura - TABELA.paddingX * 2,
            height: alturaLinha - TABELA.paddingY,
            lineBreak: indice === INDICE_ENDERECO,
            ellipsis: indice !== INDICE_ENDERECO,
          });
        x += largura;
      });

      this.y += alturaLinha;
      this.totalLinhas += 1;
    }
  }

  /** Rodapé, linha "nenhum ponto" quando aplicável e fechamento do documento. */
  async finalizar(): Promise<void> {
    const doc = this.doc;

    if (this.totalLinhas === 0) {
      const altura = 32;
      if (this.y + altura > PAGINA.altura - MARGEM.base) {
        this.novaPagina();
        this.desenharCabecalhoTabela();
      }
      doc
        .lineWidth(0.5)
        .rect(MARGEM.esquerda, this.y, LARGURA_UTIL, altura)
        .stroke(COR.bordaTabela);
      doc
        .font(FONTE_ITALICO)
        .fontSize(10)
        .fillColor(COR.cinza)
        .text(
          'Nenhum ponto encontrado para o período informado.',
          MARGEM.esquerda,
          this.y + 11,
          { width: LARGURA_UTIL, align: 'center' },
        );
      this.y += altura;
    }

    const alturaRodape = 12 + 6 + 10;
    if (this.y + alturaRodape > PAGINA.altura - MARGEM.base) {
      this.novaPagina();
    }
    this.y += 12;
    doc
      .lineWidth(0.5)
      .moveTo(MARGEM.esquerda, this.y)
      .lineTo(MARGEM.esquerda + LARGURA_UTIL, this.y)
      .stroke(COR.bordaTabela);
    doc
      .font(FONTE)
      .fontSize(8)
      .fillColor(COR.cinzaClaro)
      .text(
        `Relatório gerado pelo sistema ${TENANT.reportName} — ${this.dataGeracao}`,
        MARGEM.esquerda,
        this.y + 6,
        { width: LARGURA_UTIL, align: 'center', lineBreak: false },
      );

    doc.end();
    await this.encerrado;
  }

  /** Interrompe a escrita (cliente desconectou ou erro irrecuperável). */
  abortar(): void {
    try {
      this.doc.unpipe();
      this.doc.end();
    } catch {
      // já encerrado
    }
  }

  // ---------------------------------------------------------------------------

  private novaPagina(): void {
    this.doc.addPage();
    this.y = MARGEM.topo;
  }

  private desenharCabecalhoDocumento(): void {
    const doc = this.doc;
    const { veiculo, periodo, totalPontos, intervaloMinSeg } = this.cabecalho;
    const topo = MARGEM.topo;
    const alturaLogo = 44;
    let xTitulo = MARGEM.esquerda;

    if (this.logo) {
      try {
        doc.image(this.logo, MARGEM.esquerda, topo, {
          fit: [110, alturaLogo],
          valign: 'center',
        });
        xTitulo += 110 + 14;
      } catch {
        // logo inválida: segue sem imagem
      }
    }

    doc
      .font(FONTE_NEGRITO)
      .fontSize(17)
      .fillColor(COR.titulo)
      .text('Relatório de Rotas Detalhadas', xTitulo, topo + 8, {
        lineBreak: false,
      });
    doc
      .font(FONTE)
      .fontSize(10)
      .fillColor(COR.cinza)
      .text(
        'Pontos GPS registrados no período com geocode — para análise de rota',
        xTitulo,
        topo + 30,
        { lineBreak: false },
      );

    const larguraMeta = 220;
    const xMeta = MARGEM.esquerda + LARGURA_UTIL - larguraMeta;
    doc
      .font(FONTE)
      .fontSize(9)
      .fillColor(COR.cinza)
      .text(`Gerado em: ${this.dataGeracao}`, xMeta, topo + 4, {
        width: larguraMeta,
        align: 'right',
        lineBreak: false,
      });
    doc
      .font(FONTE)
      .fontSize(9)
      .fillColor(COR.cinza)
      .text('Total de pontos: ', xMeta, topo + 18, {
        width: larguraMeta - doc.widthOfString(String(totalPontos)),
        align: 'right',
        lineBreak: false,
        continued: true,
      })
      .font(FONTE_NEGRITO)
      .text(String(totalPontos), { lineBreak: false });

    const yLinha = topo + alturaLogo + 12;
    doc
      .lineWidth(2)
      .moveTo(MARGEM.esquerda, yLinha)
      .lineTo(MARGEM.esquerda + LARGURA_UTIL, yLinha)
      .stroke(COR.vermelho);
    this.y = yLinha + 14;

    // Cards de informação (placa, chassi, período inicial, período final)
    const cards = [
      { label: 'PLACA', valor: veiculo.placa || '—' },
      { label: 'CHASSI', valor: veiculo.chassi || '—' },
      { label: 'PERÍODO INICIAL', valor: formatarDataBR(periodo.dataInicial) },
      { label: 'PERÍODO FINAL', valor: formatarDataBR(periodo.dataFinal) },
    ];
    const gap = 8;
    const larguraCard =
      (LARGURA_UTIL - gap * (cards.length - 1)) / cards.length;
    const alturaCard = 40;
    cards.forEach((card, indice) => {
      const x = MARGEM.esquerda + indice * (larguraCard + gap);
      doc.rect(x, this.y, larguraCard, alturaCard).fill(COR.cardFundo);
      doc.rect(x, this.y, 3, alturaCard).fill(COR.vermelho);
      doc
        .font(FONTE)
        .fontSize(9)
        .fillColor(COR.cinza)
        .text(card.label, x + 12, this.y + 8, {
          width: larguraCard - 20,
          lineBreak: false,
          characterSpacing: 0.4,
        });
      doc
        .font(FONTE_NEGRITO)
        .fontSize(12)
        .fillColor(COR.cardValor)
        .text(card.valor, x + 12, this.y + 21, {
          width: larguraCard - 20,
          lineBreak: false,
          ellipsis: true,
        });
    });
    this.y += alturaCard + 14;

    // Aviso
    const prefixo = 'Atenção: ';
    const corpo =
      intervaloMinSeg > 0
        ? `este relatório contém os pontos GPS registrados pelo rastreador no período, com intervalo mínimo de ${intervaloMinSeg} s entre registros, velocidade instantânea e endereço obtido por geocodificação reversa.`
        : 'este relatório contém todos os pontos GPS registrados pelo rastreador no período, com velocidade instantânea e endereço obtido por geocodificação reversa.';
    doc.font(FONTE).fontSize(9);
    const alturaTexto = doc.heightOfString(prefixo + corpo, {
      width: LARGURA_UTIL - 24,
    });
    const alturaAviso = alturaTexto + 16;
    doc
      .lineWidth(1)
      .roundedRect(MARGEM.esquerda, this.y, LARGURA_UTIL, alturaAviso, 6)
      .fillAndStroke(COR.avisoFundo, COR.avisoBorda);
    doc
      .font(FONTE_NEGRITO)
      .fontSize(9)
      .fillColor(COR.avisoTexto)
      .text(prefixo, MARGEM.esquerda + 12, this.y + 8, {
        width: LARGURA_UTIL - 24,
        continued: true,
      })
      .font(FONTE)
      .text(corpo);
    this.y += alturaAviso + 12;
  }

  private desenharCabecalhoTabela(): void {
    const doc = this.doc;
    doc
      .rect(MARGEM.esquerda, this.y, LARGURA_UTIL, TABELA.alturaCabecalho)
      .fill(COR.titulo);

    let x = MARGEM.esquerda;
    for (const coluna of COLUNAS) {
      doc
        .font(FONTE_NEGRITO)
        .fontSize(TABELA.fonte)
        .fillColor(COR.branco)
        .text(coluna.titulo, x + TABELA.paddingX, this.y + 6, {
          width: coluna.largura - TABELA.paddingX * 2,
          lineBreak: false,
        });
      x += coluna.largura;
    }
    this.y += TABELA.alturaCabecalho;
  }
}

@Injectable()
export class ContestacaoV2PdfKitService {
  private readonly logger = new Logger(ContestacaoV2PdfKitService.name);
  private readonly logo: Buffer | null;

  constructor() {
    this.logo = carregarLogo();
    if (!this.logo) {
      this.logger.warn(
        `Logo não encontrada em ${TENANT.logoPath}; PDF de contestação V2 sairá sem logo`,
      );
    }
  }

  criarWriter(
    cabecalho: HistoricoM7ContestacaoV2CabecalhoDto,
    destino: Writable,
  ): ContestacaoV2PdfWriter {
    return new ContestacaoV2PdfWriter(cabecalho, destino, this.logo);
  }
}
