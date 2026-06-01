import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { HistoricoPdfDataDto, HistoricoSegmentoDto } from '../dto/historico-response.dto';
import { escapeHtml, formatarDuracao } from '../utils/formatters';

function carregarLogoBase64(): string {
  try {
    const logoPath = path.join(process.cwd(), 'assets', 'Logo.png');
    return fs.readFileSync(logoPath).toString('base64');
  } catch {
    return '';
  }
}

const LOGO_BASE64 = carregarLogoBase64();

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

function gerarGraficoDistribuicaoDias(segmentos: HistoricoSegmentoDto[]): string {
  if (segmentos.length === 0) return '<p style="color:#6b7280;font-style:italic;font-size:11px;">Nenhum dado para exibir.</p>';

  // Group by acc (YYYYMMDD number → "YYYY-MM-DD")
  const porDia = new Map<string, number>();
  for (const seg of segmentos) {
    const accStr = String(seg.acc);
    let dayKey = accStr;
    if (accStr.length === 8) {
      dayKey = `${accStr.slice(0, 4)}-${accStr.slice(4, 6)}-${accStr.slice(6, 8)}`;
    }
    porDia.set(dayKey, (porDia.get(dayKey) ?? 0) + 1);
  }

  const dias = Array.from(porDia.entries()).sort(([a], [b]) => a.localeCompare(b));
  const maxCount = Math.max(...dias.map(([, c]) => c), 1);

  const barWidth = 36;
  const gap = 8;
  const maxBarH = 110;
  const paddingLeft = 36;
  const paddingBottom = 42;
  const paddingTop = 20;
  const svgWidth = Math.max(dias.length * (barWidth + gap) + paddingLeft + 24, 400);
  const svgHeight = maxBarH + paddingBottom + paddingTop;

  const bars = dias
    .map(([dayKey, count], i) => {
      const barH = Math.max((count / maxCount) * maxBarH, 4);
      const x = paddingLeft + i * (barWidth + gap);
      const y = paddingTop + maxBarH - barH;
      const parts = dayKey.split('-');
      const label = parts.length === 3 ? `${parts[2]}/${parts[1]}` : dayKey;
      const fillColor = count > 0 ? '#FF0000' : '#d1d5db';
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${fillColor}" rx="3"/>
        <text x="${x + barWidth / 2}" y="${y - 4}" text-anchor="middle" font-size="9" fill="#374151" font-family="Arial">${count}</text>
        <text x="${x + barWidth / 2}" y="${svgHeight - 6}" text-anchor="middle" font-size="8" fill="#6b7280" font-family="Arial">${escapeHtml(label)}</text>
      `;
    })
    .join('');

  const yLines = [0, Math.ceil(maxCount / 2), maxCount].map((v) => {
    const y = paddingTop + maxBarH - (v / maxCount) * maxBarH;
    return `
      <line x1="${paddingLeft}" y1="${y}" x2="${svgWidth - 10}" y2="${y}" stroke="#f3f4f6" stroke-width="1"/>
      <text x="${paddingLeft - 4}" y="${y + 3}" text-anchor="end" font-size="8" fill="#9ca3af" font-family="Arial">${v}</text>
    `;
  }).join('');

  return `
    <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
      ${yLines}
      ${bars}
      <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${paddingTop + maxBarH}" stroke="#e5e7eb" stroke-width="1"/>
      <line x1="${paddingLeft}" y1="${paddingTop + maxBarH}" x2="${svgWidth - 10}" y2="${paddingTop + maxBarH}" stroke="#e5e7eb" stroke-width="1"/>
    </svg>
  `;
}

function gerarRegioesMaisVisitadas(segmentos: HistoricoSegmentoDto[]): string {
  const contagem: Record<string, number> = {};

  for (const seg of segmentos) {
    const locs = [seg.inicio.adr, seg.fim.adr];
    for (const loc of locs) {
      const key = (loc ?? '').trim();
      if (key) {
        contagem[key] = (contagem[key] ?? 0) + 1;
      }
    }
  }

  const sorted = Object.entries(contagem)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  if (sorted.length === 0) {
    return '<p style="color:#6b7280;font-style:italic;font-size:11px;">Nenhuma região identificada no período.</p>';
  }

  const maxCount = sorted[0][1];

  return sorted
    .map(([regiao, count], i) => {
      const pct = Math.round((count / maxCount) * 100);
      const rank = `${i + 1}°`;
      return `
        <div class="region-card">
          <div class="region-rank">${escapeHtml(rank)}</div>
          <div class="region-info">
            <div class="region-name">${escapeHtml(regiao)}</div>
            <div class="region-bar-wrap">
              <div class="region-bar" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="region-count">${count}x</div>
        </div>
      `;
    })
    .join('');
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

  const logoTag = LOGO_BASE64
    ? `<img src="data:image/png;base64,${LOGO_BASE64}" alt="Logo" style="height:44px;object-fit:contain;"/>`
    : '';

  const grafico = gerarGraficoDistribuicaoDias(segmentos);
  const regioes = gerarRegioesMaisVisitadas(segmentos);

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
          align-items: center;
          border-bottom: 2px solid #FF0000;
          padding-bottom: 12px;
          margin-bottom: 16px;
        }
        .header-left { display: flex; align-items: center; gap: 14px; }
        .header h1 {
          font-size: 18px;
          color: #101010;
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
          background: #f5f5f5;
          border-left: 3px solid #FF0000;
          padding: 10px 14px;
          border-radius: 0 6px 6px 0;
        }
        .summary-card label {
          font-size: 10px;
          color: #101010;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          display: block;
          margin-bottom: 4px;
        }
        .summary-card span {
          font-size: 14px;
          font-weight: 700;
          color: #101010;
        }
        h2 {
          font-size: 13px;
          color: #374151;
          margin-bottom: 8px;
        }
        .section-title {
          font-size: 12px;
          font-weight: 700;
          color: #101010;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 10px;
          padding-bottom: 4px;
          border-bottom: 1px solid #FF0000;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
        }
        th {
          background: #101010;
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
        .analytics-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 20px;
        }
        .analytics-panel {
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 14px;
          overflow: hidden;
        }
        .chart-scroll { overflow-x: auto; }
        .region-card {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 0;
          border-bottom: 1px solid #f1f5f9;
        }
        .region-card:last-child { border-bottom: none; }
        .region-rank {
          font-size: 13px;
          font-weight: 700;
          color: #101010;
          min-width: 24px;
          text-align: center;
        }
        .region-info { flex: 1; overflow: hidden; }
        .region-name {
          font-size: 10px;
          font-weight: 600;
          color: #1f2937;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          margin-bottom: 4px;
        }
        .region-bar-wrap {
          background: #f3f4f6;
          border-radius: 3px;
          height: 6px;
          width: 100%;
        }
        .region-bar {
          background: #FF0000;
          height: 6px;
          border-radius: 3px;
          min-width: 4px;
        }
        .region-count {
          font-size: 11px;
          font-weight: 700;
          color: #101010;
          min-width: 28px;
          text-align: right;
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
        <div class="header-left">
          ${logoTag}
          <div>
            <h1>Relatório de Trajetórias</h1>
            <p style="color:#6b7280;font-size:10px;margin-top:2px;">Gerado pelo sistema de rastreamento</p>
          </div>
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

      <div class="analytics-row">
        <div class="analytics-panel">
          <div class="section-title">Distribuição de Trajetos por Dia</div>
          <div class="chart-scroll">
            ${grafico}
          </div>
        </div>
        <div class="analytics-panel">
          <div class="section-title">Regiões Mais Visitadas</div>
          ${regioes}
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
        Relatório de Rastreamento — ${escapeHtml(vehicle.plate)} — ${escapeHtml(formatarDataBR(period.dataInicial))} a ${escapeHtml(formatarDataBR(period.dataFinal))}
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
