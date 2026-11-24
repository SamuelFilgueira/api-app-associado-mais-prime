import {
  SORTE_CONFIG_V2_PADRAO,
  SorteConfigView,
} from 'src/associado-sorte/mappers/sorte.mapper';

/** Configuração de base usada nos specs (promoção ativa, padrões v2). */
export function configDeTeste(
  extra: Partial<SorteConfigView> = {},
): SorteConfigView {
  return {
    baseOrigin: 'MAIS_PRIME',
    ativa: true,
    titulo: 'Associado da Sorte',
    subtitulo: null,
    regulamento: null,
    regulamentoAtualizadoEm: null,
    whatsappSuporte: '5521999990000',
    fonteCreditoDiario: 'RASPADINHA',
    faixasRaspadinha: [
      { creditos: 1, peso: 60 },
      { creditos: 3, peso: 30 },
      { creditos: 10, peso: 10 },
    ],
    creditosCheckin: 2,
    marcosSequencia: [
      { dias: 3, bonus: 2 },
      { dias: 7, bonus: 10 },
    ],
    exibirGanhadores: true,
    carenciaDias: 0,
    ...SORTE_CONFIG_V2_PADRAO,
    artes: { capaUrl: null, ganhouUrl: null, naoGanhouUrl: null },
    atualizadoEm: null,
    ...extra,
  };
}
