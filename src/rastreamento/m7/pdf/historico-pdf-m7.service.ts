import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer';
import { HistoricoM7PdfDataDto, TrajetoM7Dto } from '../dto/historico-m7-response.dto';

const MAX_ROWS_PER_PAGE = 50;

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function formatarDistancia(metros: number): string {
  if (!Number.isFinite(metros) || metros < 0) return '0 m';
  if (metros >= 1000) return `${(metros / 1000).toFixed(1)} km`;
  return `${Math.round(metros)} m`;
}

function gerarLinhaTabela(t: TrajetoM7Dto, idx: number): string {
  const bgStyle = idx % 2 !== 0 ? 'background:#f9fafb;' : '';
  return `
    <tr style="${bgStyle}">
      <td>${escapeHtml(t.tipo || 'N/D')}</td>
      <td>${escapeHtml(formatarDataHora(t.dataInicio))}</td>
      <td>${escapeHtml(formatarDataHora(t.dataFim))}</td>
      <td>${escapeHtml(t.tempoMovimento)}</td>
      <td>${escapeHtml(t.tempoParado)}</td>
      <td>${escapeHtml(t.tempoTotal)}</td>
      <td>${escapeHtml(formatarDistancia(t.distanciaMetros))}</td>
      <td>${escapeHtml(String(t.velocidadeMaxima))} km/h</td>
      <td class="addr">${escapeHtml(t.destino || '—')}</td>
    </tr>
  `;
}

function gerarHtmlRelatorio(dados: HistoricoM7PdfDataDto): string {
  const { veiculo, periodo, resumo, trajetos } = dados;
  const agora = new Date();
  const dataGeracao = formatarDataHora(agora.toISOString());

  const linhas =
    trajetos.length > 0
      ? trajetos.slice(0, MAX_ROWS_PER_PAGE).map(gerarLinhaTabela).join('')
      : `<tr><td colspan="9" style="text-align:center;color:#6b7280;font-style:italic;padding:20px;">
           Nenhum trajeto encontrado para o período informado.
         </td></tr>`;

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
          align-items: flex-start;
          border-bottom: 2px solid #2563eb;
          padding-bottom: 12px;
          margin-bottom: 16px;
        }
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
        .addr { max-width: 160px; word-break: break-word; }
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
          <p style="color:#6b7280;font-size:10px;margin-top:4px;">Histórico M7</p>
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
          <label>Trajetos</label>
          <span>${resumo.totalTrajetos}</span>
        </div>
        <div class="summary-card">
          <label>Distância Total</label>
          <span>${escapeHtml(formatarDistancia(resumo.distanciaTotalMetros))}</span>
        </div>
        <div class="summary-card">
          <label>Vel. Máxima</label>
          <span>${resumo.velocidadeMaxima.toFixed(1)} km/h</span>
        </div>
      </div>

      <h2>Trajetos do Período</h2>
      <table>
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Início</th>
            <th>Fim</th>
            <th>Movimento</th>
            <th>Parado</th>
            <th>Total</th>
            <th>Distância</th>
            <th>Vel. Máx.</th>
            <th>Destino</th>
          </tr>
        </thead>
        <tbody>
          ${linhas}
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
