import { ComandosVeiculoService } from 'src/rastreamento/services/comandos-veiculo.service';
import { BancoRastreamentoEmMemoria } from 'src/rastreamento/testing/banco-rastreamento.memoria';
import {
  TravaLivre,
  montarRastreamento,
  prepararCredenciaisDeTeste,
} from 'src/rastreamento/testing/montar-rastreamento';
import { DomainError, InfraError } from 'src/shared/erros/erros';

/**
 * Âncora e alerta de ignição por VEÍCULO. Antes o estado ficava no usuário:
 * mexer no carro B reaplicava nele a âncora do carro A.
 */
describe('ComandosVeiculoService', () => {
  const BASE = 'MAIS_PRIME';
  const CNPJ = '11222333000144';
  const CARRO_A = 'CARROA00000000001';
  const CARRO_B = 'CARROB00000000001';

  const respostaOk = {
    mensagem: 'ok',
    monitorado: 10,
    ancora_ativa: 1,
    evt_ign: 0,
    evg_ign_exec: 0,
    ancora_lat: -22.9,
    ancora_lng: -43.2,
  };

  let banco: BancoRastreamentoEmMemoria;
  let m7: {
    ancoraM7: jest.Mock;
    ignicaoM7: jest.Mock;
    getEventoPadraoM7: jest.Mock;
  };
  let trava: TravaLivre;
  let comandos: ComandosVeiculoService;
  let restaurarAmbiente: () => void;

  function montar(travaUsada: unknown = trava): void {
    comandos = montarRastreamento({
      banco,
      m7,
      logica: {},
      softruck: {},
      trava: travaUsada,
    }).comandos;
  }

  beforeEach(() => {
    restaurarAmbiente = prepararCredenciaisDeTeste();
    banco = new BancoRastreamentoEmMemoria();
    m7 = {
      ancoraM7: jest.fn().mockResolvedValue(respostaOk),
      ignicaoM7: jest.fn().mockResolvedValue(respostaOk),
      getEventoPadraoM7: jest
        .fn()
        .mockResolvedValue({ ancoraAtiva: false, evtIgn: false }),
    };
    trava = new TravaLivre();
    montar();
  });

  afterEach(() => restaurarAmbiente());

  describe('usuário com dois veículos', () => {
    let donoId: number;

    beforeEach(() => {
      donoId = banco.comUsuario().id;
      banco.comVeiculo({ userId: donoId, chassi: CARRO_A });
      banco.comVeiculo({ userId: donoId, chassi: CARRO_B });
    });

    it('ligar a âncora no A não liga no B', async () => {
      await comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: donoId });

      await expect(
        comandos.statusDaAncora(CARRO_A, { userId: donoId }),
      ).resolves.toEqual({ ancoraAtiva: true, userId: donoId });
      await expect(
        comandos.statusDaAncora(CARRO_B, { userId: donoId }),
      ).resolves.toEqual({ ancoraAtiva: false, userId: donoId });
      expect(banco.veiculo(CARRO_A)?.ancoraAtiva).toBe(true);
      // O B ficou com o valor que já valia para ele (o antigo do usuário).
      expect(banco.veiculo(CARRO_B)?.ancoraAtiva).toBe(false);
    });

    it('mexer no alerta do B não reaplica nele a âncora do A', async () => {
      await comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: donoId });

      await comandos.ignicao(CNPJ, CARRO_B, true, BASE, { userId: donoId });

      // 4º argumento = âncora enviada junto: a do B (desligada), não a do A.
      expect(m7.ignicaoM7).toHaveBeenCalledWith(
        CNPJ,
        CARRO_B,
        true,
        false,
        BASE,
      );
      expect(banco.veiculo(CARRO_B)).toMatchObject({
        ancoraAtiva: false,
        notificacaoIgnicao: true,
      });
      expect(banco.veiculo(CARRO_A)).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: false,
      });
    });

    it('status do alerta de ignição é por chassi', async () => {
      await comandos.ignicao(CNPJ, CARRO_A, true, BASE, { userId: donoId });

      await expect(
        comandos.statusDaIgnicao(CARRO_A, { userId: donoId }),
      ).resolves.toEqual({ notificacaoIgnicao: true, userId: donoId });
      await expect(
        comandos.statusDaIgnicao(CARRO_B, { userId: donoId }),
      ).resolves.toEqual({ notificacaoIgnicao: false, userId: donoId });
    });

    it('o usuário (coluna antiga) guarda "algum veículo ligado"', async () => {
      await comandos.ignicao(CNPJ, CARRO_A, true, BASE, { userId: donoId });
      expect(banco.usuario(donoId)?.notificacaoIgnicao).toBe(true);

      // Desligar no B não pode apagar o do usuário: o A continua ligado e é
      // pelo valor do usuário que as notificações ainda filtram.
      await comandos.ignicao(CNPJ, CARRO_B, false, BASE, { userId: donoId });
      expect(banco.usuario(donoId)?.notificacaoIgnicao).toBe(true);

      await comandos.ignicao(CNPJ, CARRO_A, false, BASE, { userId: donoId });
      expect(banco.usuario(donoId)?.notificacaoIgnicao).toBe(false);
    });
  });

  describe('compatibilidade: veículo ainda sem estado próprio (null)', () => {
    it('status cai no valor do usuário', async () => {
      const dono = banco.comUsuario({
        ancoraAtiva: true,
        notificacaoIgnicao: true,
      });
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });

      await expect(
        comandos.statusDaAncora(CARRO_A, { userId: dono.id }),
      ).resolves.toEqual({ ancoraAtiva: true, userId: dono.id });
      await expect(
        comandos.statusDaIgnicao(CARRO_A, { userId: dono.id }),
      ).resolves.toEqual({ notificacaoIgnicao: true, userId: dono.id });
    });

    it('o comando usa o valor do usuário para o campo que não foi pedido', async () => {
      const dono = banco.comUsuario({ notificacaoIgnicao: true });
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });

      await comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: dono.id });

      expect(m7.ancoraM7).toHaveBeenCalledWith(CNPJ, CARRO_A, true, true, BASE);
      // Depois do comando o veículo fica com o estado enviado, nos dois campos.
      expect(banco.veiculo(CARRO_A)).toMatchObject({
        ancoraAtiva: true,
        notificacaoIgnicao: true,
      });
    });

    it('estado definido no veículo prevalece sobre o do usuário', async () => {
      const dono = banco.comUsuario({ ancoraAtiva: true });
      banco.comVeiculo({
        userId: dono.id,
        chassi: CARRO_A,
        ancoraAtiva: false,
      });

      await expect(
        comandos.statusDaAncora(CARRO_A, { userId: dono.id }),
      ).resolves.toEqual({ ancoraAtiva: false, userId: dono.id });
    });
  });

  describe('auditoria (VeiculoComandoLog)', () => {
    it('comando aceito: linha OK com usuário, veículo, base, comando e valor', async () => {
      const dono = banco.comUsuario();
      const veiculo = banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });

      await comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: dono.id });

      expect(banco.comandos).toEqual([
        expect.objectContaining({
          userId: dono.id,
          userVehicleId: veiculo.id,
          chassi: CARRO_A,
          baseOrigin: BASE,
          comando: 'ANCORA',
          valor: true,
          resultado: 'OK',
          erro: null,
        }),
      ]);
    });

    it('M7 lança: linha FALHA, erro propagado e estado intacto', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });
      const falha = new Error('Erro ao atualizar ignição');
      m7.ignicaoM7.mockRejectedValue(falha);

      await expect(
        comandos.ignicao(CNPJ, CARRO_A, true, BASE, { userId: dono.id }),
      ).rejects.toBe(falha);

      expect(banco.comandos).toEqual([
        expect.objectContaining({
          comando: 'IGNICAO',
          valor: true,
          resultado: 'FALHA',
          erro: 'Erro ao atualizar ignição',
        }),
      ]);
      expect(banco.veiculo(CARRO_A)?.notificacaoIgnicao).toBeNull();
      expect(banco.usuario(dono.id)?.notificacaoIgnicao).toBe(false);
    });

    it('M7 responde `erro` com status de sucesso: linha FALHA, resposta devolvida como veio', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });
      m7.ancoraM7.mockResolvedValue({ erro: 'veículo sem rastreador' });

      await expect(
        comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: dono.id }),
      ).resolves.toEqual({ erro: 'veículo sem rastreador' });

      expect(banco.comandos[0]).toMatchObject({
        resultado: 'FALHA',
        erro: 'veículo sem rastreador',
      });
      expect(banco.veiculo(CARRO_A)?.ancoraAtiva).toBeNull();
    });

    it('falha ao gravar o estado depois do comando propaga (não é engolida)', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });
      await comandos.statusDaAncora(CARRO_A, { userId: dono.id });
      const falha = new Error('conexão perdida');
      m7.ancoraM7.mockImplementation(() => {
        banco.falharNaProxima('user', falha);
        return Promise.resolve(respostaOk);
      });

      await expect(
        comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: dono.id }),
      ).rejects.toBe(falha);
    });
  });

  describe('sem checagem de posse', () => {
    it('chassi de outro associado: o comando vale e o estado fica no veículo dele', async () => {
      const dono = banco.comUsuario();
      const estranho = banco.comUsuario();
      const veiculo = banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });

      await expect(
        comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: estranho.id }),
      ).resolves.toEqual(respostaOk);

      expect(banco.veiculo(CARRO_A)?.ancoraAtiva).toBe(true);
      expect(banco.comandos[0]).toMatchObject({
        userId: estranho.id,
        userVehicleId: veiculo.id,
        resultado: 'OK',
      });
      await expect(
        comandos.statusDaAncora(CARRO_A, { userId: estranho.id }),
      ).resolves.toEqual({ ancoraAtiva: true, userId: dono.id });
    });

    it('chassi sem vínculo local: estado lido na M7, comando enviado, auditoria gravada', async () => {
      const autor = banco.comUsuario();
      m7.getEventoPadraoM7.mockResolvedValue({
        ancoraAtiva: true,
        evtIgn: false,
      });

      await expect(
        comandos.ignicao(CNPJ, CARRO_A, true, BASE, { userId: autor.id }),
      ).resolves.toEqual(respostaOk);

      expect(m7.ignicaoM7).toHaveBeenCalledWith(
        CNPJ,
        CARRO_A,
        true,
        true,
        BASE,
      );
      expect(banco.comandos[0]).toMatchObject({
        userId: autor.id,
        userVehicleId: null,
        resultado: 'OK',
      });
    });

    it('o vínculo do próprio usuário tem preferência quando existe', async () => {
      const outro = banco.comUsuario();
      const eu = banco.comUsuario();
      banco.comVeiculo({ userId: outro.id, chassi: CARRO_A });
      const meu = banco.comVeiculo({ userId: eu.id, chassi: CARRO_A });

      await comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: eu.id });

      expect(banco.veiculos.find((v) => v.id === meu.id)?.ancoraAtiva).toBe(
        true,
      );
      await expect(
        comandos.statusDaAncora(CARRO_A, { userId: eu.id }),
      ).resolves.toEqual({ ancoraAtiva: true, userId: eu.id });
    });

    it('token que não é de associado (painel): auditoria com userId 0', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });

      await comandos.ancora(CNPJ, CARRO_A, true, BASE, {
        userId: null,
        painelUserId: 77,
      });

      expect(banco.comandos[0]).toMatchObject({
        userId: null,
        adminPanelUserId: 77,
        resultado: 'OK',
      });
    });
  });

  describe('trava por chassi', () => {
    it('cada comando roda sob a trava do próprio chassi', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });

      await comandos.ancora(CNPJ, ` ${CARRO_A.toLowerCase()} `, true, BASE, {
        userId: dono.id,
      });

      expect(trava.chaves).toEqual([`rastreamento:comando:${CARRO_A}`]);
    });

    it('outro comando do mesmo veículo em andamento: espera e roda em seguida', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });
      let tentativas = 0;
      montar({
        tentar: async (
          _chave: string,
          _ttl: number,
          fn: () => Promise<unknown>,
        ) =>
          ++tentativas < 3
            ? { executou: false }
            : { executou: true, valor: await fn() },
      });

      await expect(
        comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: dono.id }),
      ).resolves.toEqual(respostaOk);
      expect(tentativas).toBe(3);
      expect(m7.ancoraM7).toHaveBeenCalledTimes(1);
    });

    it('trava ocupada além da espera: 409 com code, sem falar com a M7', async () => {
      jest.useFakeTimers();
      try {
        montar({ tentar: () => Promise.resolve({ executou: false }) });

        const pedido = comandos
          .ancora(CNPJ, CARRO_A, true, BASE, { userId: null })
          .catch((e: unknown) => e);
        await jest.advanceTimersByTimeAsync(21_000);
        const erro = (await pedido) as DomainError;

        expect(erro).toBeInstanceOf(DomainError);
        expect(erro.status).toBe(409);
        expect(erro.code).toBe('RASTREAMENTO_COMANDO_EM_ANDAMENTO');
        expect(m7.ancoraM7).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('Redis fora: o comando roda sem a trava (não recusa)', async () => {
      const dono = banco.comUsuario();
      banco.comVeiculo({ userId: dono.id, chassi: CARRO_A });
      montar({ tentar: () => Promise.reject(new InfraError('redis')) });

      await expect(
        comandos.ancora(CNPJ, CARRO_A, true, BASE, { userId: dono.id }),
      ).resolves.toEqual(respostaOk);
      expect(banco.veiculo(CARRO_A)?.ancoraAtiva).toBe(true);
    });
  });
});
