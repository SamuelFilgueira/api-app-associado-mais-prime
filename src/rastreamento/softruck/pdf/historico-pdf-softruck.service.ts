import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer';
import { HistoricoPdfDataDto, HistoricoSegmentoDto } from '../dto/historico-response.dto';
import { escapeHtml, formatarDuracao } from '../utils/formatters';

/** Número máximo de segmentos exibidos por página da tabela PDF */
const MAX_ROWS_PER_PAGE = 40;

/** Formata distância em metros para exibição legível */
function formatarDistancia(metros: number): string {
  if (!Number.isFinite(metros) || metros < 0) return '0 m';
  if (metros >= 1000) {
    return `${(metros / 1000).toFixed(1)} km`;
  }
  return `${Math.round(metros)} m`;
}

/** Formata velocidade em km/h para exibição */
function formatarVelocidade(kmh: number): string {
  if (!Number.isFinite(kmh)) return '0 km/h';
  return `${kmh.toFixed(1)} km/h`;
}

/** Formata data ISO ou string de data para exibição dd/MM/yyyy HH:mm */
function formatarDataHora(valor: string): string {
  if (!valor) return 'N/D';
  try {
    const d = new Date(valor);
    if (isNaN(d.getTime())) return valor;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return valor;
  }
}

/** Formata data ISO YYYY-MM-DD para dd/MM/yyyy */
function formatarDataBR(isoDate: string): string {
  if (!isoDate) return isoDate;
  const [ano, mes, dia] = isoDate.split('-');
  if (!ano || !mes || !dia) return isoDate;
  return `${dia}/${mes}/${ano}`;
}

/** Gera uma linha HTML da tabela de segmentos */
function gerarLinhaTabela(seg: HistoricoSegmentoDto, indice: number): string {
  const estileLinha = indice % 2 === 0 ? '' : 'background:#f9fafb;';
  return `
    <tr style="${estileLinha}">
      <td>${escapeHtml(formatarDataHora(seg.inicio.act))}</td>
      <td>${escapeHtml(formatarDataHora(seg.fim.act))}</td>
      <td>${escapeHtml(formatarDuracao(seg.duracaoSegundos))}</td>
      <td>${escapeHtml(formatarDistancia(seg.distanciaMetros))}</td>
      <td>${escapeHtml(formatarVelocidade(seg.velocidadeMedia))}</td>
      <td>${escapeHtml(formatarVelocidade(seg.velocidadeMaxima))}</td>
      <td class="addr">${escapeHtml(seg.inicio.adr ?? `${seg.inicio.lat.toFixed(5)}, ${seg.inicio.lng.toFixed(5)}`)}</td>
      <td class="addr">${escapeHtml(seg.fim.adr ?? `${seg.fim.lat.toFixed(5)}, ${seg.fim.lng.toFixed(5)}`)}</td>
    </tr>
  `;
}

/** Renderiza o HTML completo do relatório de trajetórias */
function gerarHtmlRelatorio(dados: HistoricoPdfDataDto): string {
  const { vehicle, period, summary, segmentos } = dados;
  const agora = new Date();
  const dataGeracao = formatarDataHora(agora.toISOString());

  const linhasTabela = segmentos.length > 0
    ? segmentos.slice(0, MAX_ROWS_PER_PAGE).map(gerarLinhaTabela).join('')
    : `<tr><td colspan="8" style="text-align:center;color:#6b7280;font-style:italic;padding:20px;">
         Nenhum segmento encontrado para o período informado.
       </td></tr>`;

  const tabelaExtraPages = segmentos.length > MAX_ROWS_PER_PAGE
    ? segmentos.slice(MAX_ROWS_PER_PAGE).map(gerarLinhaTabela).join('')
    : '';

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Relatório de Trajetórias — ${escapeHtml(vehicle.plate)}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: Arial, Helvetica, sans-serif;
          font-size: 11px;
          color: #1f2937;
          padding: 24px;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 2px solid #2563eb;
          padding-bottom: 12px;
          margin-bottom: 16px;
        }
        .header h1 {
          font-size: 18px;
          color: #1e40af;
        }
        .header .meta-right {
          text-align: right;
          font-size: 10px;
          color: #6b7280;
        }
        .info-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          margin-bottom: 16px;
        }
        .info-card {
          background: #f3f4f6;
          border-radius: 6px;
          padding: 10px 14px;
        }
        .info-card label {
          font-size: 10px;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          display: block;
          margin-bottom: 4px;
        }
        .info-card span {
          font-size: 13px;
          font-weight: 700;
          color: #111827;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-bottom: 20px;
        }
        .summary-card {
          background: #eff6ff;
          border-left: 3px solid #2563eb;
          padding: 10px 14px;
          border-radius: 0 6px 6px 0;
        }
        .summary-card label {
          font-size: 10px;
          color: #1d4ed8;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          display: block;
          margin-bottom: 4px;
        }
        .summary-card span {
          font-size: 14px;
          font-weight: 700;
          color: #1e3a8a;
        }
        h2 {
          font-size: 13px;
          color: #374151;
          margin-bottom: 8px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
        }
        th {
          background: #1e40af;
          color: #fff;
          padding: 7px 8px;
          text-align: left;
          font-weight: 600;
          white-space: nowrap;
        }
        td {
          border: 1px solid #e5e7eb;
          padding: 6px 8px;
          vertical-align: top;
        }
        .addr {
          max-width: 180px;
          word-break: break-word;
        }
        .footer {
          margin-top: 16px;
          text-align: center;
          font-size: 9px;
          color: #9ca3af;
          border-top: 1px solid #e5e7eb;
          padding-top: 8px;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <h1>Relatório de Trajetórias</h1>
          <p style="color:#6b7280;font-size:10px;margin-top:2px;">Gerado pelo sistema de rastreamento</p>
        </div>
        <div class="meta-right">
          <p>Gerado em: ${escapeHtml(dataGeracao)}</p>
          <p>Período: ${escapeHtml(formatarDataBR(period.dataInicial))} – ${escapeHtml(formatarDataBR(period.dataFinal))}</p>
        </div>
      </div>

      <div class="info-grid">
        <div class="info-card">
          <label>Placa</label>
          <span>${escapeHtml(vehicle.plate)}</span>
        </div>
        <div class="info-card">
          <label>Veículo</label>
          <span>${escapeHtml(vehicle.brandName)} ${escapeHtml(vehicle.modelName)}</span>
        </div>
        <div class="info-card">
          <label>Chassi</label>
          <span>${escapeHtml(vehicle.chassi)}</span>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <label>Total de Trajetos</label>
          <span>${summary.totalSegmentos}</span>
        </div>
        <div class="summary-card">
          <label>Distância Total</label>
          <span>${escapeHtml(formatarDistancia(summary.distanciaTotalMetros))}</span>
        </div>
        <div class="summary-card">
          <label>Tempo em Movimento</label>
          <span>${escapeHtml(formatarDuracao(summary.duracaoTotalSegundos))}</span>
        </div>
        <div class="summary-card">
          <label>Vel. Máxima</label>
          <span>${escapeHtml(formatarVelocidade(summary.velocidadeMaximaGeral))}</span>
        </div>
        <div class="summary-card">
          <label>Vel. Média</label>
          <span>${escapeHtml(formatarVelocidade(summary.velocidadeMediaGeral))}</span>
        </div>
        <div class="summary-card">
          <label>Dias com Dados</label>
          <span>${summary.diasComDados} / ${period.totalDias}</span>
        </div>
      </div>

      <h2>Detalhamento de Trajetos (${segmentos.length} no total)</h2>
      <table>
        <thead>
          <tr>
            <th>Início</th>
            <th>Fim</th>
            <th>Duração</th>
            <th>Distância</th>
            <th>Vel. Média</th>
            <th>Vel. Máxima</th>
            <th>Endereço Inicial</th>
            <th>Endereço Final</th>
          </tr>
        </thead>
        <tbody>
          ${linhasTabela}
        </tbody>
      </table>

      ${tabelaExtraPages ? `
        <table style="margin-top:0;border-top:none;">
          <tbody>${tabelaExtraPages}</tbody>
        </table>
      ` : ''}

      ${segmentos.length > MAX_ROWS_PER_PAGE ? `
        <p style="font-size:10px;color:#6b7280;margin-top:8px;font-style:italic;">
          Exibindo ${segmentos.length} segmento(s) no total.
        </p>
      ` : ''}

      <div class="footer">
        Relatório de Rastreamento Softruck — ${escapeHtml(vehicle.plate)} — ${escapeHtml(formatarDataBR(period.dataInicial))} a ${escapeHtml(formatarDataBR(period.dataFinal))}
      </div>
    </body>
    </html>
  `;
}

@Injectable()
export class HistoricoPdfSoftruckService {
  private readonly logger = new Logger(HistoricoPdfSoftruckService.name);

  /**
   * Gera o PDF de histórico de trajetórias em memória usando Puppeteer.
   * Retorna um Buffer pronto para envio via HTTP.
   */
  async gerarPdf(dados: HistoricoPdfDataDto): Promise<Buffer> {
    const html = gerarHtmlRelatorio(dados);

    const browser = await puppeteer.launch({
      headless: true,
      ...(process.env.PUPPETEER_EXECUTABLE_PATH && {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      }),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdf = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '16px', right: '16px', bottom: '16px', left: '16px' },
      });

      this.logger.log(
        `PDF gerado: ${dados.segmentos.length} segmentos, placa=${dados.vehicle.plate}, período=${dados.period.dataInicial}→${dados.period.dataFinal}`,
      );

      return Buffer.from(pdf);
    } catch (error) {
      this.logger.error(
        `Erro ao gerar PDF Softruck: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao gerar PDF de histórico de trajetórias',
      );
    } finally {
      await browser.close();
    }
  }
}
