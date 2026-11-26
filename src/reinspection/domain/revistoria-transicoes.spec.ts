import type { ReinspectionStatus } from '@prisma/client';
import {
  CODIGO_TRANSICAO_INVALIDA,
  ORIGENS,
  TODOS_OS_STATUS,
  TRANSICOES_PERMITIDAS,
  erroDeTransicaoInvalida,
  estaEmAvaliacao,
  exigirArestasNaTabela,
  statusAposAprovarFoto,
  transicaoPermitida,
} from 'src/reinspection/domain/revistoria-transicoes';

type Aresta = [ReinspectionStatus, ReinspectionStatus];

/** A tabela inteira, escrita por extenso: mudar a regra exige mudar o teste. */
const PERMITIDAS: Aresta[] = [
  ['PENDENTE', 'EM_ANALISE'],
  ['PENDENTE', 'APROVADA'],
  ['PENDENTE', 'REPROVADA'],
  ['PENDENTE', 'FINALIZADA'],
  ['EM_ANALISE', 'APROVADA'],
  ['EM_ANALISE', 'REPROVADA'],
  ['EM_ANALISE', 'FINALIZADA'],
  ['REPROVADA', 'EM_ANALISE'],
  ['REPROVADA', 'FINALIZADA'],
  ['APROVADA', 'REPROVADA'],
  ['APROVADA', 'FINALIZADA'],
];

const PROIBIDAS: Aresta[] = [
  // Nada volta para PENDENTE.
  ['EM_ANALISE', 'PENDENTE'],
  ['REPROVADA', 'PENDENTE'],
  ['APROVADA', 'PENDENTE'],
  // Aprovação não vence reprovação de foto simultânea.
  ['REPROVADA', 'APROVADA'],
  // Aprovar foto / PATCH status atrasado não rebaixam a aprovada.
  ['APROVADA', 'EM_ANALISE'],
  // FINALIZADA é terminal.
  ['FINALIZADA', 'PENDENTE'],
  ['FINALIZADA', 'EM_ANALISE'],
  ['FINALIZADA', 'APROVADA'],
  ['FINALIZADA', 'REPROVADA'],
];

describe('máquina de estados da revistoria', () => {
  it('conhece os cinco estados do schema', () => {
    expect([...TODOS_OS_STATUS].sort()).toEqual(
      ['APROVADA', 'EM_ANALISE', 'FINALIZADA', 'PENDENTE', 'REPROVADA'].sort(),
    );
  });

  it.each(PERMITIDAS)('%s → %s é permitida', (de, para) => {
    expect(transicaoPermitida(de, para)).toBe(true);
  });

  it.each(PROIBIDAS)('%s → %s é proibida', (de, para) => {
    expect(transicaoPermitida(de, para)).toBe(false);
  });

  it('a tabela não tem aresta além das listadas', () => {
    const daTabela = TODOS_OS_STATUS.flatMap((de) =>
      TRANSICOES_PERMITIDAS[de].map((para) => `${de}>${para}`),
    );
    expect(daTabela.sort()).toEqual(
      PERMITIDAS.map(([de, para]) => `${de}>${para}`).sort(),
    );
  });

  it.each(TODOS_OS_STATUS)(
    '%s nunca vai para si mesmo e tem ao menos um destino proibido',
    (status) => {
      expect(transicaoPermitida(status, status)).toBe(false);
      const proibidos = TODOS_OS_STATUS.filter(
        (para) => !transicaoPermitida(status, para),
      );
      expect(proibidos.length).toBeGreaterThanOrEqual(1);
    },
  );

  it('PENDENTE não recebe transição de ninguém (só nasce assim)', () => {
    for (const de of TODOS_OS_STATUS) {
      expect(transicaoPermitida(de, 'PENDENTE')).toBe(false);
    }
  });

  it('FINALIZADA é terminal', () => {
    expect(TRANSICOES_PERMITIDAS.FINALIZADA).toEqual([]);
  });

  describe('origens de cada operação', () => {
    const casos: Array<
      [keyof typeof ORIGENS, ReinspectionStatus, ReinspectionStatus[]]
    > = [
      ['MARCAR_EM_ANALISE', 'EM_ANALISE', ['PENDENTE', 'REPROVADA']],
      [
        'FINALIZAR',
        'FINALIZADA',
        ['PENDENTE', 'EM_ANALISE', 'APROVADA', 'REPROVADA'],
      ],
      ['APROVAR', 'APROVADA', ['PENDENTE', 'EM_ANALISE']],
      [
        'REPROVAR_POR_FOTO',
        'REPROVADA',
        ['PENDENTE', 'EM_ANALISE', 'APROVADA'],
      ],
    ];

    it.each(casos)(
      '%s → %s parte de %j, e todas estão na tabela',
      (operacao, destino, origens) => {
        expect([...ORIGENS[operacao]]).toEqual(origens);
        expect(() =>
          exigirArestasNaTabela(ORIGENS[operacao], destino),
        ).not.toThrow();
      },
    );

    it('finalizar cobre todo estado que não é FINALIZADA', () => {
      expect([...ORIGENS.FINALIZAR].sort()).toEqual(
        TODOS_OS_STATUS.filter((s) => s !== 'FINALIZADA').sort(),
      );
    });

    it('aprovar NÃO parte de REPROVADA (a reprovação simultânea vence)', () => {
      expect(ORIGENS.APROVAR).not.toContain('REPROVADA');
    });
  });

  describe('exigirArestasNaTabela', () => {
    it('lança (erro de programação) quando alguma origem não está na tabela', () => {
      expect(() =>
        exigirArestasNaTabela(['EM_ANALISE', 'FINALIZADA'], 'APROVADA'),
      ).toThrow('FINALIZADA → APROVADA');
    });
  });

  describe('avaliação por foto', () => {
    const casos: Array<[ReinspectionStatus, boolean]> = [
      ['PENDENTE', true],
      ['EM_ANALISE', true],
      ['REPROVADA', true],
      ['APROVADA', false],
      ['FINALIZADA', false],
    ];

    it.each(casos)('%s em avaliação? %s', (status, esperado) => {
      expect(estaEmAvaliacao(status)).toBe(esperado);
    });

    it('aprovar foto: sobra reprovada → REPROVADA; senão → EM_ANALISE', () => {
      expect(statusAposAprovarFoto(true)).toBe('REPROVADA');
      expect(statusAposAprovarFoto(false)).toBe('EM_ANALISE');
    });

    it('todo destino do recálculo é alcançável a partir dos estados em avaliação', () => {
      const destinos = [
        statusAposAprovarFoto(true),
        statusAposAprovarFoto(false),
      ];
      for (const de of TODOS_OS_STATUS.filter(estaEmAvaliacao)) {
        for (const para of destinos) {
          if (de !== para) expect(transicaoPermitida(de, para)).toBe(true);
        }
      }
    });
  });

  it('erro de transição inválida é 409 com código estável e os dois estados', () => {
    const erro = erroDeTransicaoInvalida('FINALIZADA', 'APROVADA');
    expect(erro.status).toBe(409);
    expect(erro.code).toBe(CODIGO_TRANSICAO_INVALIDA);
    expect(erro.code).toBe('REVISTORIA_TRANSICAO_INVALIDA');
    expect(erro.detalhes).toEqual({
      statusAtual: 'FINALIZADA',
      statusPretendido: 'APROVADA',
    });
  });
});
