import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { lerCpfsDaPlanilha } from 'src/notifications/helpers/planilha-cpf.leitor';

/**
 * Casos que estavam em `situacao-cadastro-notification.service.spec.ts`
 * (`extrairCpfsDaPlanilha`, privado do service). As expectativas são as
 * mesmas; a leitura da planilha passou para este helper.
 */
describe('lerCpfsDaPlanilha', () => {
  const gerarPlanilha = async (
    linhas: Array<Array<string | number>>,
  ): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Relatorio');
    linhas.forEach((linha) => sheet.addRow(linha));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  it('extrai CPFs válidos usando a coluna do cabeçalho "CPF"', async () => {
    const buffer = await gerarPlanilha([
      ['Nome', 'CPF', 'Situacao'],
      ['Fulano', '529.982.247-25', 'Inadimplente'],
      ['Beltrano', 1234567890, 'Inadimplente'], // numérico: zero à esquerda perdido
      ['Ciclano', '529.982.247-25', 'Inadimplente'], // duplicado
      ['Invalido', '111.111.111-11', 'Inadimplente'], // dígitos repetidos
      ['Lixo', 'abc', 'Inadimplente'],
    ]);

    const resultado = await lerCpfsDaPlanilha(buffer, 10_000);

    expect(resultado.cpfs).toEqual(['52998224725', '01234567890']);
    expect(resultado.cpfsInvalidos).toEqual(['111.111.111-11', 'abc']);
    expect(resultado.duplicadosRemovidos).toBe(1);
    expect(resultado.totalLinhas).toBe(5);
  });

  it('usa a coluna A quando não há cabeçalho', async () => {
    const buffer = await gerarPlanilha([['529.982.247-25'], ['01234567890']]);

    const resultado = await lerCpfsDaPlanilha(buffer, 10_000);

    expect(resultado.cpfs).toEqual(['52998224725', '01234567890']);
    expect(resultado.cpfsInvalidos).toEqual([]);
  });

  it('lança BadRequest quando não há CPF válido', async () => {
    const buffer = await gerarPlanilha([['CPF'], ['abc'], ['123']]);

    await expect(lerCpfsDaPlanilha(buffer, 10_000)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lança BadRequest para arquivo que não é .xlsx', async () => {
    await expect(
      lerCpfsDaPlanilha(Buffer.from('isto nao e um excel'), 10_000),
    ).rejects.toThrow(BadRequestException);
  });

  it('lança BadRequest acima do limite de CPFs por envio', async () => {
    const buffer = await gerarPlanilha([['529.982.247-25'], ['01234567890']]);

    await expect(lerCpfsDaPlanilha(buffer, 1)).rejects.toThrow(
      'A planilha excede o limite de 1 CPFs por envio',
    );
  });
});
