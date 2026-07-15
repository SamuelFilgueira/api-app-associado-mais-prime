import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { TrajetoPosicao, TrajetoResumo } from '../dto/trajeto.dto';

interface TrajetoPdfData {
  chassi: string;
  veiculoId: number;
  dataInicial: string;
  dataFinal: string;
  posicoes: TrajetoPosicao[];
  resumo: TrajetoResumo | null;
}

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

function formatarDataBR(isoDate: string): string {
  if (!isoDate) return isoDate;
  const [ano, mes, dia] = isoDate.split('-');
  if (!ano || !mes || !dia) return isoDate;
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHora(valor: string): string {
  if (!valor) return 'N/D';

  const bruto = valor.trim();
  const brMatch = bruto.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );

  if (brMatch) {
    const [, dia, mes, ano, hora, minuto, segundo] = brMatch;
    return `${dia}/${mes}/${ano} ${hora}:${minuto}:${segundo ?? '00'}`;
  }

  const d = new Date(bruto.includes('T') ? bruto : bruto.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) {
    return bruto;
  }

  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  const hora = String(d.getHours()).padStart(2, '0');
  const minuto = String(d.getMinutes()).padStart(2, '0');
  const segundo = String(d.getSeconds()).padStart(2, '0');
  return `${dia}/${mes}/${ano} ${hora}:${minuto}:${segundo}`;
}

function formatarPosicao(latitude: number, longitude: number): string {
  return `${latitude},\n${longitude}`;
}

function formatarKm(valor: number | null | undefined): string {
  const num = Number(valor ?? 0);
  if (!Number.isFinite(num)) return '0 km';
  const ptBr = num.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${ptBr} km`;
}

function formatarVelocidade(valor: number | null | undefined): string {
  const num = Number(valor ?? 0);
  if (!Number.isFinite(num)) return '0 km/h';
  return `${Math.round(num)} km/h`;
}

function gerarLinhasPosicoes(posicoes: TrajetoPosicao[]): string {
  if (!posicoes.length) {
    return `<tr><td colspan="5" style="text-align:center;color:#6b7280;font-style:italic;padding:20px;">Nenhuma posição encontrada para o período informado.</td></tr>`;
  }

  return posicoes
    .map((ponto, indice) => {
      const bgStyle = indice % 2 !== 0 ? 'background:#f9fafb;' : '';
      return `
        <tr style="${bgStyle}">
          <td>${escapeHtml(formatarDataHora(ponto.data))}</td>
          <td>${escapeHtml(String(ponto.velocidade ?? 0))}</td>
          <td>${escapeHtml(String(ponto.ignicao ?? 'N/D'))}</td>
          <td style="white-space:pre-line; font-family:monospace;">${escapeHtml(
            formatarPosicao(Number(ponto.latitude), Number(ponto.longitude)),
          )}</td>
          <td class="addr">${escapeHtml(String(ponto.endereco ?? '—'))}</td>
        </tr>
      `;
    })
    .join('');
}

function gerarHtmlRelatorio(data: TrajetoPdfData): string {
  const agora = new Date();
  const dataGeracao = formatarDataHora(agora.toISOString());
  const resumo = data.resumo;
  const logoTag = LOGO_BASE64
    ? `<img src="data:image/png;base64,${LOGO_BASE64}" alt="Logo" style="height:44px;object-fit:contain;"/>`
    : '';

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Relatório de Trajetórias — Lógica</title>
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
        .header h1 { font-size: 18px; color: #101010; }
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
          grid-template-columns: repeat(3, 1fr);
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
        .summary-card span { font-size: 14px; font-weight: 700; color: #101010; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; }
        th {
          background: #101010;
          color: #fff;
          padding: 7px 8px;
          text-align: left;
          font-weight: 600;
          white-space: nowrap;
        }
        td { border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; }
        .addr { max-width: 280px; word-break: break-word; }
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
            <p style="color:#6b7280;font-size:10px;margin-top:4px;">Integração Lógica Soluções</p>
          </div>
        </div>
        <div class="meta-right">
          <p>Gerado em: ${escapeHtml(dataGeracao)}</p>
        </div>
      </div>

      <div class="info-grid">
        <div class="info-card">
          <label>Chassi</label>
          <span>${escapeHtml(data.chassi)}</span>
        </div>
        <div class="info-card">
          <label>Veículo ID</label>
          <span>${data.veiculoId}</span>
        </div>
        <div class="info-card">
          <label>Período</label>
          <span>${escapeHtml(formatarDataBR(data.dataInicial))} — ${escapeHtml(formatarDataBR(data.dataFinal))}</span>
        </div>
      </div>

      <div class="summary-grid">
        <div class="summary-card">
          <label>Total de Posições</label>
          <span>${data.posicoes.length}</span>
        </div>
        <div class="summary-card">
          <label>Primeiro Registro</label>
          <span>${escapeHtml(data.posicoes[0]?.data ? formatarDataHora(data.posicoes[0].data) : 'N/D')}</span>
        </div>
        <div class="summary-card">
          <label>Último Registro</label>
          <span>${escapeHtml(data.posicoes[data.posicoes.length - 1]?.data ? formatarDataHora(data.posicoes[data.posicoes.length - 1].data) : 'N/D')}</span>
        </div>
      </div>

      <div class="summary-grid" style="grid-template-columns: repeat(5, 1fr);">
        <div class="summary-card">
          <label>Distância do Percurso</label>
          <span>${escapeHtml(formatarKm(resumo?.distanciaTotal))}</span>
        </div>
        <div class="summary-card">
          <label>Tempo Ignição Ligada</label>
          <span>${escapeHtml(resumo?.tempoIgnicaoLigada ?? '00:00:00')}</span>
        </div>
        <div class="summary-card">
          <label>Velocidade Média</label>
          <span>${escapeHtml(formatarVelocidade(resumo?.velocidadeMedia))}</span>
        </div>
        <div class="summary-card">
          <label>Velocidade Máxima</label>
          <span>${escapeHtml(formatarVelocidade(resumo?.velocidadeMaxima))}</span>
        </div>
        <div class="summary-card">
          <label>Tempo Motor Ocioso</label>
          <span>${escapeHtml(resumo?.tempoMotorOcioso ?? '00:00:00')}</span>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>KM/H</th>
            <th>Ignição</th>
            <th>Posição</th>
            <th>Endereço</th>
          </tr>
        </thead>
        <tbody>
          ${gerarLinhasPosicoes(data.posicoes)}
        </tbody>
      </table>

      <div class="footer">
        Relatório gerado pelo sistema Mais Prime — ${escapeHtml(dataGeracao)}
      </div>
    </body>
    </html>
  `;
}

@Injectable()
export class TrajetoPdfLogicaService {
  private readonly logger = new Logger(TrajetoPdfLogicaService.name);

  async gerarPdf(data: TrajetoPdfData): Promise<Buffer> {
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
      const html = gerarHtmlRelatorio(data);
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
        `Erro ao gerar PDF de trajetos da Lógica: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
      throw new InternalServerErrorException(
        'Erro ao gerar PDF de trajetos da Lógica',
      );
    } finally {
      await browser.close();
    }
  }
}
