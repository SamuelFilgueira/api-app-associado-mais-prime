import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { SituacaoCadastroNotificationService } from 'src/notifications/services/situacao-cadastro-notification.service';

describe('SituacaoCadastroNotificationService', () => {
  let service: SituacaoCadastroNotificationService;

  beforeEach(() => {
    service = new SituacaoCadastroNotificationService({} as any);
  });

  const gerarPlanilha = async (
    linhas: Array<Array<string | number>>,
  ): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Relatorio');
    linhas.forEach((linha) => sheet.addRow(linha));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  describe('extrairCpfsDaPlanilha', () => {
    it('extrai CPFs válidos usando a coluna do cabeçalho "CPF"', async () => {
      const buffer = await gerarPlanilha([
        ['Nome', 'CPF', 'Situacao'],
        ['Fulano', '529.982.247-25', 'Inadimplente'],
        ['Beltrano', 1234567890, 'Inadimplente'], // numérico: zero à esquerda perdido
        ['Ciclano', '529.982.247-25', 'Inadimplente'], // duplicado
        ['Invalido', '111.111.111-11', 'Inadimplente'], // dígitos repetidos
        ['Lixo', 'abc', 'Inadimplente'],
      ]);

      const resultado = await (service as any).extrairCpfsDaPlanilha(buffer);

      expect(resultado.cpfs).toEqual(['52998224725', '01234567890']);
      expect(resultado.cpfsInvalidos).toEqual(['111.111.111-11', 'abc']);
      expect(resultado.duplicadosRemovidos).toBe(1);
      expect(resultado.totalLinhas).toBe(5);
    });

    it('usa a coluna A quando não há cabeçalho', async () => {
      const buffer = await gerarPlanilha([
        ['529.982.247-25'],
        ['01234567890'],
      ]);

      const resultado = await (service as any).extrairCpfsDaPlanilha(buffer);

      expect(resultado.cpfs).toEqual(['52998224725', '01234567890']);
      expect(resultado.cpfsInvalidos).toEqual([]);
    });

    it('lança BadRequest quando não há CPF válido', async () => {
      const buffer = await gerarPlanilha([['CPF'], ['abc'], ['123']]);

      await expect(
        (service as any).extrairCpfsDaPlanilha(buffer),
      ).rejects.toThrow(BadRequestException);
    });

    it('lança BadRequest para arquivo que não é .xlsx', async () => {
      const buffer = Buffer.from('isto nao e um excel');

      await expect(
        (service as any).extrairCpfsDaPlanilha(buffer),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('validarDigitosCpf', () => {
    it('aceita CPFs com dígitos verificadores corretos', () => {
      expect((service as any).validarDigitosCpf('52998224725')).toBe(true);
      expect((service as any).validarDigitosCpf('01234567890')).toBe(true);
    });

    it('rejeita CPFs inválidos', () => {
      expect((service as any).validarDigitosCpf('52998224724')).toBe(false);
      expect((service as any).validarDigitosCpf('11111111111')).toBe(false);
      expect((service as any).validarDigitosCpf('123')).toBe(false);
    });
  });

  describe('parseDataPayload', () => {
    it('sem data, o padrão leva para a tela de financeiro do app', () => {
      expect(service.parseDataPayload(undefined)).toEqual({
        type: 'internal_route',
        screen: 'financeiro',
      });
      expect(service.parseDataPayload('')).toEqual({
        type: 'internal_route',
        screen: 'financeiro',
      });
    });

    it('parseia JSON válido e preenche type padrão', () => {
      // screen presente sem type → internal_route
      expect(
        service.parseDataPayload('{"screen":"Boletos"}'),
      ).toEqual({ type: 'internal_route', screen: 'Boletos' });

      // sem screen e sem type → situacao_cadastro
      expect(
        service.parseDataPayload('{"campaignId":"abc"}'),
      ).toEqual({ type: 'situacao_cadastro', campaignId: 'abc' });

      expect(
        service.parseDataPayload(
          '{"type":"internal_route","screen":"Boletos"}',
        ),
      ).toEqual({ type: 'internal_route', screen: 'Boletos' });
    });

    it('corrige mojibake nos valores string do payload', () => {
      expect(
        service.parseDataPayload('{"screen":"SituaÃ§Ã£o"}'),
      ).toEqual({ type: 'internal_route', screen: 'Situação' });
    });

    it('lança BadRequest para JSON inválido ou não-objeto', () => {
      expect(() => service.parseDataPayload('{invalido')).toThrow(
        BadRequestException,
      );
      expect(() => service.parseDataPayload('[1,2]')).toThrow(
        BadRequestException,
      );
      expect(() => service.parseDataPayload('"texto"')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('corrigirTextoUtf8', () => {
    it('corrige texto com mojibake latin1 → utf8', () => {
      expect(service.corrigirTextoUtf8('AtualizaÃ§Ã£o de cadastro')).toBe(
        'Atualização de cadastro',
      );
      expect(service.corrigirTextoUtf8('SituaÃ§Ã£o alterada')).toBe(
        'Situação alterada',
      );
      expect(service.corrigirTextoUtf8('Sua situaÃ§Ã£o Ã© InadimplÃªncia')).toBe(
        'Sua situação é Inadimplência',
      );
    });

    it('não altera texto já correto', () => {
      expect(service.corrigirTextoUtf8('Atualização de cadastro')).toBe(
        'Atualização de cadastro',
      );
      expect(service.corrigirTextoUtf8('Situação: ATIVO')).toBe(
        'Situação: ATIVO',
      );
      expect(service.corrigirTextoUtf8('SÃO PAULO')).toBe('SÃO PAULO');
      expect(service.corrigirTextoUtf8('Boleto vence hoje')).toBe(
        'Boleto vence hoje',
      );
      expect(service.corrigirTextoUtf8('')).toBe('');
    });

    it('corrige mojibake vindo de cp1252 (aspas curvas e travessão)', () => {
      // "não" em utf8 lido como cp1252: e3 -> ã, mas 0x83 vira ƒ (cp1252)
      expect(service.corrigirTextoUtf8('nÃ£o â€” atenÃ§Ã£o')).toBe(
        'não — atenção',
      );
    });
  });
});
