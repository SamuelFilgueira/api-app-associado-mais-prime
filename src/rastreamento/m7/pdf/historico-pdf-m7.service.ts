import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';
import {
  DiaM7ResumoDto,
  HistoricoM7PdfDataDto,
  ViagemM7Dto,
} from '../dto/historico-m7-response.dto';

function carregarLogoBase64(): string {
  try {
    const logoPath = path.join(process.cwd(), 'assets', 'Logo.png');
    return fs.readFileSync(logoPath).toString('base64');
  } catch {
    return '';
  }
}

const LOGO_BASE64 = carregarLogoBase64();

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatarHora(valor: string): string {
  if (!valor) return 'N/D';
  try {
    const d = new Date(valor);
    if (isNaN(d.getTime())) return valor;
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  } catch {
    return valor;
  }
}

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

function formatarDataBR(isoDate: string): string {
  if (!isoDate) return isoDate;
  const [ano, mes, dia] = isoDate.split('-');
  if (!ano || !mes || !dia) return isoDate;
  return `${dia}/${mes}/${ano}`;
}

function formatarDistanciaKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) return '0 km';
  return `${km} km`;
}

function gerarGraficoDistribuicaoDias(dias: DiaM7ResumoDto[]): string {
  if (dias.length === 0) return '<p style="color:#6b7280;font-style:italic;font-size:11px;">Nenhum dado para exibir.</p>';

  const maxViagens = Math.max(...dias.map((d) => d.viagens.length), 1);
  const barWidth = 36;
  const gap = 8;
  const maxBarH = 110;
  const paddingLeft = 36;
  const paddingBottom = 42;
  const paddingTop = 20;
  const svgWidth = Math.max(dias.length * (barWidth + gap) + paddingLeft + 24, 400);
  const svgHeight = maxBarH + paddingBottom + paddingTop;

  const bars = dias
    .map((dia, i) => {
      const count = dia.viagens.length;
      const barH = Math.max((count / maxViagens) * maxBarH, 4);
      const x = paddingLeft + i * (barWidth + gap);
      const y = paddingTop + maxBarH - barH;
      const parts = dia.data.split('-');
      const label = parts.length === 3 ? `${parts[2]}/${parts[1]}` : dia.data;
      const fillColor = count > 0 ? '#2563eb' : '#d1d5db';
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${fillColor}" rx="3"/>
        <text x="${x + barWidth / 2}" y="${y - 4}" text-anchor="middle" font-size="9" fill="#374151" font-family="Arial">${count}</text>
        <text x="${x + barWidth / 2}" y="${svgHeight - 6}" text-anchor="middle" font-size="8" fill="#6b7280" font-family="Arial">${escapeHtml(label)}</text>
      `;
    })
    .join('');

  const yLines = [0, Math.ceil(maxViagens / 2), maxViagens].map((v) => {
    const y = paddingTop + maxBarH - (v / maxViagens) * maxBarH;
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

function gerarRegioesMaisVisitadas(dias: DiaM7ResumoDto[]): string {
  const contagem: Record<string, number> = {};

  for (const dia of dias) {
    for (const v of dia.viagens) {
      const locs = [v.origem, v.destino];
      for (const loc of locs) {
        const key = (loc ?? '').trim();
        if (key && key !== '—') {
          contagem[key] = (contagem[key] ?? 0) + 1;
        }
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

function gerarLinhasViagens(dia: DiaM7ResumoDto): string {
  const cabecalhoDia = `
    <tr class="day-header">
      <td colspan="7">
        <strong>${escapeHtml(formatarDataBR(dia.data))}</strong>
        &nbsp;—&nbsp;${dia.viagens.length} viagem(ns)
        &nbsp;—&nbsp;${escapeHtml(formatarDistanciaKm(dia.distanciaTotalKm))}
      </td>
    </tr>
  `;

  const linhasViagens = dia.viagens
    .map((v: ViagemM7Dto, idx: number) => {
      const bgStyle = idx % 2 !== 0 ? 'background:#f9fafb;' : '';
      return `
      <tr style="${bgStyle}">
        <td>${escapeHtml(formatarHora(v.saida))}</td>
        <td>${escapeHtml(formatarHora(v.chegada))}</td>
        <td class="addr">${escapeHtml(v.origem || '—')}</td>
        <td class="addr">${escapeHtml(v.destino || '—')}</td>
        <td>${escapeHtml(v.tempoMovimento)}</td>
        <td>${escapeHtml(formatarDistanciaKm(v.distanciaKm))}</td>
        <td>${escapeHtml(String(v.velocidadeMaxima))} km/h</td>
      </tr>
    `;
    })
    .join('');

  return cabecalhoDia + linhasViagens;
}

function gerarHtmlRelatorio(dados: HistoricoM7PdfDataDto): string {
  const { veiculo, periodo, resumo, dias } = dados;
  const agora = new Date();
  const dataGeracao = formatarDataHora(agora.toISOString());

  const corpoTabela =
    dias.length > 0
      ? dias.map(gerarLinhasViagens).join('')
      : `<tr><td colspan="7" style="text-align:center;color:#6b7280;font-style:italic;padding:20px;">
           Nenhuma viagem encontrada para o período informado.
         </td></tr>`;

  const logoTag = LOGO_BASE64
    ? `<img src="data:image/png;base64,${LOGO_BASE64}" alt="Logo" style="height:44px;object-fit:contain;"/>`
    : '';

  const grafico = gerarGraficoDistribuicaoDias(dias);
  const regioes = gerarRegioesMaisVisitadas(dias);

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Relatório de Trajetórias M7 — ${escapeHtml(veiculo.placa)}</title>
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
          border-bottom: 2px solid #2563eb;
          padding-bottom: 12px;
          margin-bottom: 16px;
        }
        .header-left { display: flex; align-items: center; gap: 14px; }
        .header h1 { font-size: 18px; color: #1e40af; }
        .header .meta-right { text-align: right; font-size: 10px; color: #6b7280; }
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
        .info-card span { font-size: 13px; font-weight: 700; color: #111827; }
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
        .summary-card span { font-size: 14px; font-weight: 700; color: #1e3a8a; }
        h2 { font-size: 13px; color: #374151; margin-bottom: 8px; }
        .section-title {
          font-size: 12px;
          font-weight: 700;
          color: #1e40af;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 10px;
          padding-bottom: 4px;
          border-bottom: 1px solid #bfdbfe;
        }
        table { width: 100%; border-collapse: collapse; font-size: 10px; }
        th {
          background: #1e40af;
          color: #fff;
          padding: 7px 8px;
          text-align: left;
          font-weight: 600;
          white-space: nowrap;
        }
        td { border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; }
        tr.day-header td {
          background: #dbeafe;
          color: #1e3a8a;
          font-weight: 600;
          font-size: 11px;
          border: 1px solid #bfdbfe;
          padding: 8px 10px;
        }
        .addr { max-width: 200px; word-break: break-word; }
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
          color: #1e40af;
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
          background: #e0e7ff;
          border-radius: 3px;
          height: 6px;
          width: 100%;
        }
        .region-bar {
          background: #2563eb;
          height: 6px;
          border-radius: 3px;
          min-width: 4px;
        }
        .region-count {
          font-size: 11px;
          font-weight: 700;
          color: #1e40af;
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
            <p style="color:#6b7280;font-size:10px;margin-top:4px;">Histórico M7</p>
          </div>
        </div>
        <div class="meta-right">
          <p>Gerado em: ${escapeHtml(dataGeracao)}</p>
        </div>
      </div>

      <div class="info-grid">
        <div class="info-card">
          <label>Placa</label>
          <span>${escapeHtml(veiculo.placa)}</span>
        </div>
        <div class="info-card">
          <label>Chassi</label>
          <span>${escapeHtml(veiculo.chassi)}</span>
        </div>
        <div class="info-card">
          <label>Período</label>
          <span>${escapeHtml(formatarDataBR(periodo.dataInicial))} — ${escapeHtml(formatarDataBR(periodo.dataFinal))}</span>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <label>Dias com Dados</label>
          <span>${resumo.diasComDados}</span>
        </div>
        <div class="summary-card">
          <label>Total de Viagens</label>
          <span>${resumo.totalViagens}</span>
        </div>
        <div class="summary-card">
          <label>Distância Total</label>
          <span>${escapeHtml(formatarDistanciaKm(resumo.distanciaTotalKm))}</span>
        </div>
        <div class="summary-card">
          <label>Vel. Máxima</label>
          <span>${resumo.velocidadeMaxima} km/h</span>
        </div>
      </div>

      <div class="analytics-row">
        <div class="analytics-panel">
          <div class="section-title">Distribuição de Viagens por Dia</div>
          <div class="chart-scroll">
            ${grafico}
          </div>
        </div>
        <div class="analytics-panel">
          <div class="section-title">Regiões Mais Visitadas</div>
          ${regioes}
        </div>
      </div>

      <h2>Viagens do Período</h2>
      <table>
        <thead>
          <tr>
            <th>Saída</th>
            <th>Chegada</th>
            <th>Origem</th>
            <th>Destino</th>
            <th>Tempo Movimento</th>
            <th>Distância</th>
            <th>Vel. Máx.</th>
          </tr>
        </thead>
        <tbody>
          ${corpoTabela}
        </tbody>
      </table>

      <div class="footer">
        Relatório gerado pelo sistema Mais Prime Benefícios — ${escapeHtml(dataGeracao)}
      </div>
    </body>
    </html>
  `;
}

@Injectable()
export class HistoricoPdfM7Service {
  private readonly logger = new Logger(HistoricoPdfM7Service.name);

  async gerarPdf(dados: HistoricoM7PdfDataDto): Promise<Buffer> {
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
      const html = gerarHtmlRelatorio(dados);
      await page.setContent(html, { waitUntil: 'networkidle0' });

      const pdf = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '20px', right: '16px', bottom: '20px', left: '16px' },
      });

      return Buffer.from(pdf);
    } catch (error) {
      this.logger.error(
        `Erro ao gerar PDF M7: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException('Erro ao gerar PDF de histórico M7');
    } finally {
      await browser.close();
    }
  }
}
