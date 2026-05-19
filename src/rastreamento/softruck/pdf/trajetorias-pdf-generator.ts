import { InternalServerErrorException, Logger } from '@nestjs/common';
import puppeteer from 'puppeteer';
import {
  TrajetoriaSoftruckRota,
  TrajetoriasSoftruckResponse,
} from '../dto/trajetorias.dto';
import { escapeHtml, formatarDataYYYYMMDDParaBR } from '../utils/formatters';
import { normalizarCoord } from '../utils/geo.utils';

export interface RotaComEndereco {
  startDate: string;
  endDate: string;
  durationFormatted: string;
  distanceInKm: number;
  maxSpeed: number;
  averageSpeed: number;
  startAddress: string;
  endAddress: string;
}

export interface RelatorioTrajetoriaPdfData {
  placa: string;
  brandName: string;
  modelName: string;
  periodo: string;
  rotas: RotaComEndereco[];
}

const logger = new Logger('TrajectoriasPdfGenerator');

export async function gerarPdfTrajetorias(
  trajetoriasData: TrajetoriasSoftruckResponse,
  startDate: string,
  endDate: string,
  resolverEnderecos: (
    rotas: TrajetoriaSoftruckRota[],
  ) => Promise<Map<string, string>>,
): Promise<Buffer> {
  const enderecoMap = await resolverEnderecos(trajetoriasData.routes);

  const rotasComEndereco: RotaComEndereco[] = trajetoriasData.routes.map(
    (rota) => {
      const chaveOrigem = normalizarCoord(
        rota.startPosition.latitude,
        rota.startPosition.longitude,
      );
      const chaveDestino = normalizarCoord(
        rota.endPosition.latitude,
        rota.endPosition.longitude,
      );
      const fallbackOrigem = `Endereço não identificado (${rota.startPosition.latitude.toFixed(5)}, ${rota.startPosition.longitude.toFixed(5)})`;
      const fallbackDestino = `Endereço não identificado (${rota.endPosition.latitude.toFixed(5)}, ${rota.endPosition.longitude.toFixed(5)})`;

      return {
        startDate: rota.startDate,
        endDate: rota.endDate,
        durationFormatted: rota.durationFormatted,
        distanceInKm: rota.distanceInKm,
        maxSpeed: rota.maxSpeed,
        averageSpeed: rota.averageSpeed,
        startAddress: enderecoMap.get(chaveOrigem) ?? fallbackOrigem,
        endAddress: enderecoMap.get(chaveDestino) ?? fallbackDestino,
      };
    },
  );

  const dadosPdf: RelatorioTrajetoriaPdfData = {
    placa: trajetoriasData.vehicle.plate,
    brandName: trajetoriasData.vehicle.brandName,
    modelName: trajetoriasData.vehicle.modelName,
    periodo: `${formatarDataYYYYMMDDParaBR(startDate)} - ${formatarDataYYYYMMDDParaBR(endDate)}`,
    rotas: rotasComEndereco,
  };

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const html = gerarHtmlTrajetorias(dadosPdf);
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px',
      },
    });

    return Buffer.from(pdf);
  } catch (error) {
    logger.error(
      `Erro ao gerar PDF de trajetórias: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );
    throw new InternalServerErrorException('Erro ao gerar PDF de trajetórias');
  } finally {
    await browser.close();
  }
}

export function gerarHtmlTrajetorias(data: RelatorioTrajetoriaPdfData): string {
  const linhas = data.rotas
    .map(
      (rota, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(rota.startDate)}</td>
          <td>${escapeHtml(rota.endDate)}</td>
          <td>${escapeHtml(rota.durationFormatted)}</td>
          <td>${rota.distanceInKm.toFixed(2)} km</td>
          <td>${rota.maxSpeed.toFixed(1)} km/h</td>
          <td>${rota.averageSpeed.toFixed(1)} km/h</td>
          <td>${escapeHtml(rota.startAddress)}</td>
          <td>${escapeHtml(rota.endAddress)}</td>
        </tr>
      `,
    )
    .join('');

  const semDados = `
    <tr>
      <td colspan="9" class="empty">Nenhuma trajetória encontrada para o período informado.</td>
    </tr>
  `;

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <title>Relatório de Trajetórias</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            color: #1f2937;
            font-size: 11px;
          }

          h1 {
            margin: 0 0 8px;
            font-size: 18px;
          }

          .meta {
            margin-bottom: 16px;
          }

          .meta p {
            margin: 2px 0;
          }

          table {
            width: 100%;
            border-collapse: collapse;
          }

          th,
          td {
            border: 1px solid #d1d5db;
            padding: 6px 8px;
            text-align: left;
            vertical-align: top;
          }

          th {
            background: #f3f4f6;
            font-weight: 700;
          }

          tr:nth-child(even) td {
            background: #f9fafb;
          }

          .empty {
            text-align: center;
            color: #6b7280;
            font-style: italic;
          }
        </style>
      </head>
      <body>
        <h1>Relatório de Trajetórias</h1>
        <div class="meta">
          <p><strong>Placa:</strong> ${escapeHtml(data.placa)}</p>
          <p><strong>Veículo:</strong> ${escapeHtml(data.brandName)} ${escapeHtml(data.modelName)}</p>
          <p><strong>Período:</strong> ${escapeHtml(data.periodo)}</p>
          <p><strong>Total de trechos:</strong> ${data.rotas.length}</p>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Início</th>
              <th>Fim</th>
              <th>Duração</th>
              <th>Distância</th>
              <th>Vel. Máx.</th>
              <th>Vel. Média</th>
              <th>Localização Origem</th>
              <th>Localização Destino</th>
            </tr>
          </thead>
          <tbody>
            ${data.rotas.length > 0 ? linhas : semDados}
          </tbody>
        </table>
      </body>
    </html>
  `;
}
