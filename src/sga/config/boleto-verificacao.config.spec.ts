import {
  BoletoVerificacaoConfig,
  INTERVALO_BASE_MS,
  deveConsultarSga,
  excedeuIdadeMaxima,
  intervaloConsultaMs,
  loadBoletoVerificacaoConfig,
  prazoFinalPoller,
} from './boleto-verificacao.config';

const MIN = 60_000;
const DIA = 86_400_000;

describe('boleto-verificacao.config', () => {
  describe('loadBoletoVerificacaoConfig', () => {
    it('aplica os defaults quando o env está vazio', () => {
      expect(loadBoletoVerificacaoConfig({})).toEqual({
        intervaloBaseMs: INTERVALO_BASE_MS,
        maxDias: 30,
        intervaloApos24hMin: 10,
        intervaloApos7dMin: 60,
        espacamentoMs: 1500,
      });
    });

    it('lê os valores do env', () => {
      const config = loadBoletoVerificacaoConfig({
        BOLETO_VERIFICACAO_MAX_DIAS: '45',
        BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN: '5',
        BOLETO_VERIFICACAO_INTERVALO_APOS_7D_MIN: '30',
        BOLETO_VERIFICACAO_ESPACAMENTO_MS: '0',
      });
      expect(config.maxDias).toBe(45);
      expect(config.intervaloApos24hMin).toBe(5);
      expect(config.intervaloApos7dMin).toBe(30);
      expect(config.espacamentoMs).toBe(0);
    });

    it('rejeita valores fora da faixa', () => {
      expect(() =>
        loadBoletoVerificacaoConfig({ BOLETO_VERIFICACAO_MAX_DIAS: '0' }),
      ).toThrow('BOLETO_VERIFICACAO_MAX_DIAS');
      expect(() =>
        loadBoletoVerificacaoConfig({
          BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN: 'x',
        }),
      ).toThrow('BOLETO_VERIFICACAO_INTERVALO_APOS_24H_MIN');
    });
  });

  describe('cadência por idade', () => {
    const config: BoletoVerificacaoConfig = loadBoletoVerificacaoConfig({});
    const agora = Date.UTC(2026, 9, 6, 12, 0, 0);

    it('intervaloConsultaMs: 2 min até 24h, 10 min até 7 dias, 60 min depois', () => {
      expect(intervaloConsultaMs(config, 1 * 60 * MIN)).toBe(2 * MIN);
      expect(intervaloConsultaMs(config, 2 * DIA)).toBe(10 * MIN);
      expect(intervaloConsultaMs(config, 10 * DIA)).toBe(60 * MIN);
    });

    it('nas primeiras 24h consulta em todo disparo', () => {
      expect(
        deveConsultarSga(config, {
          criadoEm: agora - 3 * 60 * MIN,
          ultimaConsultaEm: agora - 1 * MIN,
          agora,
        }),
      ).toBe(true);
    });

    it('após 24h só consulta quando o intervalo da faixa passou (com meia janela de tolerância)', () => {
      const criadoEm = agora - 2 * DIA;
      expect(
        deveConsultarSga(config, {
          criadoEm,
          ultimaConsultaEm: agora - 3 * MIN,
          agora,
        }),
      ).toBe(false);
      expect(
        deveConsultarSga(config, {
          criadoEm,
          ultimaConsultaEm: agora - 9 * MIN,
          agora,
        }),
      ).toBe(true);
      expect(
        deveConsultarSga(config, { criadoEm, ultimaConsultaEm: null, agora }),
      ).toBe(true);
    });

    it('excedeuIdadeMaxima e prazoFinalPoller usam maxDias', () => {
      expect(excedeuIdadeMaxima(config, agora - 29 * DIA, agora)).toBe(false);
      expect(excedeuIdadeMaxima(config, agora - 31 * DIA, agora)).toBe(true);
      expect(prazoFinalPoller(config, agora)).toBe(agora + 30 * DIA);
    });
  });
});
