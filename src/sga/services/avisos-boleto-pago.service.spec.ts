import { MailService } from 'src/infra/mail/mail.service';
import { DomainError, ehErroTransitorio } from 'src/shared/erros/erros';
import { PagamentoBoletoRepository } from 'src/sga/repositories/pagamento-boleto.repository';
import { AvisosBoletoPagoService } from 'src/sga/services/avisos-boleto-pago.service';
import { SuriNotificacaoService } from 'src/sga/services/suri-notificacao.service';

/**
 * Consumidor do evento `boleto.pago`: e-mail para a equipe e WhatsApp para
 * o associado, uma vez cada, mesmo com o job entregue mais de uma vez.
 */
describe('AvisosBoletoPagoService', () => {
  /** Linha do pagamento em memória: os marcadores são gravados de verdade. */
  let linha: Record<string, unknown>;
  let pagamentos: {
    buscarPorNossoNumero: jest.Mock;
    reivindicarAvisoPorEmail: jest.Mock;
    devolverAvisoPorEmail: jest.Mock;
    reivindicarAvisoPorWhatsapp: jest.Mock;
    devolverAvisoPorWhatsapp: jest.Mock;
    veiculoDoBoleto: jest.Mock;
  };
  let mail: { sendBoletoRevistoriaPago: jest.Mock };
  let suri: { enviarTemplateComResultado: jest.Mock };
  let servico: AvisosBoletoPagoService;
  const evento = { nossoNumero: '123', debugId: 'dbg' };

  beforeEach(() => {
    linha = {
      id: 1,
      userVehicleId: 7,
      pago: true,
      pagoNotificadoEm: null,
      suriNotificadoEm: null,
      nomeAssociado: 'Fulano de Tal',
      telefoneAssociado: '31999999999',
    };
    pagamentos = {
      buscarPorNossoNumero: jest.fn(() => Promise.resolve({ ...linha })),
      reivindicarAvisoPorEmail: jest.fn((_id: number, agora: Date) => {
        if (linha.pagoNotificadoEm) return Promise.resolve(false);
        linha.pagoNotificadoEm = agora;
        return Promise.resolve(true);
      }),
      devolverAvisoPorEmail: jest.fn((_id: number, marcadoEm: Date) => {
        if (linha.pagoNotificadoEm === marcadoEm) linha.pagoNotificadoEm = null;
        return Promise.resolve();
      }),
      reivindicarAvisoPorWhatsapp: jest.fn((_id: number, agora: Date) => {
        if (linha.suriNotificadoEm) return Promise.resolve(false);
        linha.suriNotificadoEm = agora;
        return Promise.resolve(true);
      }),
      devolverAvisoPorWhatsapp: jest.fn((_id: number, marcadoEm: Date) => {
        if (linha.suriNotificadoEm === marcadoEm) linha.suriNotificadoEm = null;
        return Promise.resolve();
      }),
      veiculoDoBoleto: jest
        .fn()
        .mockResolvedValue({ chassi: '9BWZZZ377VT004251', plate: 'ABC1D23' }),
    };
    mail = { sendBoletoRevistoriaPago: jest.fn().mockResolvedValue(undefined) };
    suri = {
      enviarTemplateComResultado: jest
        .fn()
        .mockResolvedValue({ aceito: true, status: 200 }),
    };
    servico = new AvisosBoletoPagoService(
      pagamentos as unknown as PagamentoBoletoRepository,
      mail as unknown as MailService,
      suri as unknown as SuriNotificacaoService,
    );
  });

  it('envia o e-mail à equipe e o WhatsApp ao associado', async () => {
    const r = await servico.executar(evento);

    expect(r).toEqual({ email: 'enviado', whatsapp: 'enviado' });
    expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledWith(
      '9BWZZZ377VT004251',
      'ABC1D23',
      'dbg',
    );
    expect(suri.enviarTemplateComResultado).toHaveBeenCalledWith(
      expect.objectContaining({
        nome: 'Fulano de Tal',
        telefoneCelular: '31999999999',
        contexto: 'boleto-pago',
      }),
    );
    expect(linha.pagoNotificadoEm).toBeInstanceOf(Date);
  });

  it('o e-mail sai ANTES do WhatsApp (é ele que tem marcador)', async () => {
    const ordem: string[] = [];
    mail.sendBoletoRevistoriaPago.mockImplementation(() => {
      ordem.push('email');
      return Promise.resolve();
    });
    suri.enviarTemplateComResultado.mockImplementation(() => {
      ordem.push('whatsapp');
      return Promise.resolve({ aceito: true, status: 200 });
    });

    await servico.executar(evento);

    expect(ordem).toEqual(['email', 'whatsapp']);
  });

  it('duas entregas simultâneas do mesmo evento: UM e-mail', async () => {
    await Promise.all([servico.executar(evento), servico.executar(evento)]);

    expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
  });

  it('WhatsApp falha por rede: o job falha; na nova tentativa o e-mail NÃO repete e o WhatsApp sai uma vez', async () => {
    suri.enviarTemplateComResultado.mockRejectedValueOnce(
      new Error('ECONNRESET'),
    );

    await expect(servico.executar(evento)).rejects.toThrow('ECONNRESET');
    const r = await servico.executar(evento);

    expect(r).toEqual({ email: 'ja_enviado', whatsapp: 'enviado' });
    expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
    expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])(
    'Suri fora (HTTP %i): erro transitório — vale nova tentativa',
    async (status) => {
      suri.enviarTemplateComResultado.mockResolvedValue({
        aceito: false,
        status,
      });

      const erro: unknown = await servico.executar(evento).then(
        () => null,
        (e: unknown) => e,
      );

      expect(ehErroTransitorio(erro)).toBe(true);
    },
  );

  it('Suri recusa (HTTP 400, template inexistente): não insiste; o resultado diz que foi recusado', async () => {
    suri.enviarTemplateComResultado.mockResolvedValue({
      aceito: false,
      status: 400,
    });

    await expect(servico.executar(evento)).resolves.toEqual({
      email: 'enviado',
      whatsapp: 'recusado',
    });
  });

  it('e-mail falha: o marcador é devolvido, o WhatsApp não sai nesta execução e a nova tentativa envia os dois', async () => {
    mail.sendBoletoRevistoriaPago.mockRejectedValueOnce(new Error('SMTP fora'));

    await expect(servico.executar(evento)).rejects.toThrow('SMTP fora');
    expect(linha.pagoNotificadoEm).toBeNull();
    expect(suri.enviarTemplateComResultado).not.toHaveBeenCalled();

    const r = await servico.executar(evento);

    expect(r).toEqual({ email: 'enviado', whatsapp: 'enviado' });
    expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(2);
    expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
  });

  it('evento entregue de novo depois de tudo enviado (job reexecutado, evento recriado): nem e-mail nem WhatsApp repetem', async () => {
    await servico.executar(evento);

    await expect(servico.executar(evento)).resolves.toEqual({
      email: 'ja_enviado',
      whatsapp: 'ja_enviado',
    });
    expect(mail.sendBoletoRevistoriaPago).toHaveBeenCalledTimes(1);
    expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
  });

  it('duas entregas simultâneas do mesmo evento: UM WhatsApp', async () => {
    await Promise.all([servico.executar(evento), servico.executar(evento)]);

    expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
  });

  it('recusa definitiva da Suri mantém o marcador: a reentrega não insiste', async () => {
    suri.enviarTemplateComResultado.mockResolvedValue({
      aceito: false,
      status: 400,
    });
    await servico.executar(evento);

    await expect(servico.executar(evento)).resolves.toMatchObject({
      whatsapp: 'ja_enviado',
    });
    expect(suri.enviarTemplateComResultado).toHaveBeenCalledTimes(1);
  });

  it('Suri fora devolve o marcador (a nova tentativa pode enviar)', async () => {
    suri.enviarTemplateComResultado.mockResolvedValueOnce({
      aceito: false,
      status: 503,
    });

    await expect(servico.executar(evento)).rejects.toThrow('HTTP 503');
    expect(linha.suriNotificadoEm).toBeNull();

    await expect(servico.executar(evento)).resolves.toMatchObject({
      whatsapp: 'enviado',
    });
  });

  it('sem nome ou telefone (boleto antigo): só o e-mail', async () => {
    linha.telefoneAssociado = null;

    await expect(servico.executar(evento)).resolves.toEqual({
      email: 'enviado',
      whatsapp: 'sem_contato',
    });
    expect(suri.enviarTemplateComResultado).not.toHaveBeenCalled();
  });

  it.each([
    ['linha inexistente', null],
    ['boleto que não está pago', { id: 1, pago: false }],
  ])(
    'evento sem pagamento gravado (%s): erro definitivo, nada é enviado',
    async (_caso, registro) => {
      pagamentos.buscarPorNossoNumero.mockResolvedValue(registro);

      const erro: unknown = await servico.executar(evento).then(
        () => null,
        (e: unknown) => e,
      );

      expect(erro).toBeInstanceOf(DomainError);
      expect(ehErroTransitorio(erro)).toBe(false);
      expect(mail.sendBoletoRevistoriaPago).not.toHaveBeenCalled();
      expect(suri.enviarTemplateComResultado).not.toHaveBeenCalled();
    },
  );
});
