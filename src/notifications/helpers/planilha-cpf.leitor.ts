import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  CpfsDaPlanilha,
  separarCpfs,
} from 'src/notifications/domain/planilha-cpf';

/**
 * Lê os CPFs da primeira aba de uma planilha `.xlsx`. Se a primeira linha
 * tiver um cabeçalho contendo "cpf", usa essa coluna; caso contrário usa a
 * coluna A. Arquivo ilegível, vazio, sem CPF válido ou acima do limite vira
 * 400 com a mensagem que o painel mostra.
 */
export async function lerCpfsDaPlanilha(
  buffer: Buffer,
  maximoDeCpfs: number,
): Promise<CpfsDaPlanilha> {
  const workbook = new ExcelJS.Workbook();
  try {
    // Cast necessário: o tipo Buffer do exceljs conflita com o Buffer do Node
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    throw new BadRequestException(
      'Arquivo inválido. Envie uma planilha Excel no formato .xlsx',
    );
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount === 0) {
    throw new BadRequestException('A planilha está vazia');
  }

  // Detecta a coluna de CPF pelo cabeçalho da primeira linha
  let colunaCpf = 1;
  let linhaInicial = 1;
  worksheet.getRow(1).eachCell((cell, colNumber) => {
    if (/cpf/i.test(cell.text ?? '')) {
      colunaCpf = colNumber;
      linhaInicial = 2;
    }
  });

  const valores: string[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber < linhaInicial) return;
    const valorBruto = String(row.getCell(colunaCpf).text ?? '').trim();
    if (valorBruto) valores.push(valorBruto);
  });

  const extracao = separarCpfs(valores);
  if (extracao.cpfs.length === 0) {
    throw new BadRequestException(
      'Nenhum CPF válido encontrado na planilha. Verifique a coluna de CPFs e o formato do arquivo.',
    );
  }
  if (extracao.cpfs.length > maximoDeCpfs) {
    throw new BadRequestException(
      `A planilha excede o limite de ${maximoDeCpfs} CPFs por envio`,
    );
  }
  return extracao;
}
