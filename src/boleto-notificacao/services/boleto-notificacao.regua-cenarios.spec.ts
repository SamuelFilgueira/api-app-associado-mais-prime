/**
 * Testes de cenário da régua v2 com PAYLOADS REAIS da Hinova (formato exato do
 * retorno de /listar/boleto-associado/periodo observado em produção em
 * 10/09/2026). Simula a rotina dia a dia — status do boleto muda no "SGA"
 * simulado (pagamento/cancelamento) e verifica-se EXATAMENTE quais pushes
 * sairiam em cada dia. Nenhuma chamada real (Expo e SGA mockados).
 */
import { Prisma } from '@prisma/client';
import { BoletoNotificacaoService } from 'src/boleto-notificacao/services/boleto-notificacao.service';
import { SgaBoletoPeriodoClient } from 'src/boleto-notificacao/services/sga-boleto-periodo.client';
import { loadBoletoNotificacaoConfig } from 'src/boleto-notificacao/config/boleto-notificacao.config';
import { addDays, formatDateISO, parseDateSga } from 'src/shared/date.util';

jest.mock('src/config/tenant.config', () => ({
  TENANT: {
    baseNames: ['MAIS_PRIME', 'MAIS_PRIME_RS'],
    defaultBase: 'MAIS_PRIME',
  },
}));

// ── Boletos no formato REAL da Hinova ─────────────────────────────────────────

/** Boleto real do Kaio (FECHAMENTO, pessoa física, venc. efetivo 15/09). */
function boletoKaio(overrides: Record<string, unknown> = {}) {
  return {
    nosso_numero: 3436861,
    linha_digitavel: '23793.08600 90000.343682 61029.878008 4 15700000000000',
    codigo_tipo_boleto: '5',
    tipo_boleto: 'FECHAMENTO',
    valor_boleto: '0.00',
    codigo_associado: 67519,
    nome_associado: 'KAIO BRAGA MONTEIRO DA SILVA',
    cpf: '18886548729',
    celular: '(21) 97024-8624',
    email: 'kaiobmonteiro@gmail.com',
    data_emissao: '2026-09-02',
    data_vencimento: '2026-09-15',
    data_vencimento_original: '2026-09-15',
    data_pagamento: null,
    codigo_situacao_boleto: '2',
    situacao_boleto: 'ABERTO',
    mes_referente: '09/2026',
    codigo_mgfformapagamento: '1',
    pix: { qrcode: null, copia_cola: null },
    veiculos: [
      {
        codigo_veiculo: 94176,
        codigo_tipo_veiculo: '57',
        codigo_regional: '1',
        placa: 'TTK3D73',
        chassi: 'WBS21HJ00SFU11698',
        modelo: 'M3 COMPETITION M 3.0 BI-TB 510CV',
        marca: 'BMW',
        situacao_veiculo: 'ATIVO',
      },
    ],
    ...overrides,
  };
}

/** Boleto real de locadora (CNPJ no campo cpf). */
function boletoLocadora(overrides: Record<string, unknown> = {}) {
  return boletoKaio({
    nosso_numero: 3417516,
    codigo_associado: 69402,
    nome_associado: 'LETAMOTOS LOCADORA LTDA',
    cpf: '58034733000127',
    valor_boleto: '1080.00',
    veiculos: [
      { codigo_veiculo: 97309, placa: 'TTF6I56', situacao_veiculo: 'ATIVO' },
    ],
    ...overrides,
  });
}

/** Boleto real de QUITAÇÃO reemitida (venc. efetivo hoje, original antigo). */
function boletoQuitacao(overrides: Record<string, unknown> = {}) {
  return boletoKaio({
    nosso_numero: 3417537,
    codigo_tipo_boleto: '27',
    tipo_boleto: 'QUITAÇÃO DE DÉBITO',
    codigo_associado: 32022,
    nome_associado: 'VINICIUS GANDRA MOREIRA',
    cpf: '06380048707',
    data_vencimento: '2026-09-15',
    data_vencimento_original: '2026-02-20',
    mes_referente: '01/2026',
    veiculos: [
      {
        codigo_veiculo: 81866,
        placa: 'KPV8F21',
        situacao_veiculo: 'INADIMPLENTE +90',
      },
    ],
    ...overrides,
  });
}

// ── Harness: SGA simulado + prisma em memória + Expo capturado ────────────────

interface PushCapturado {
  dia: string;
  tipo: string;
  cpf: string;
  titulo: string;
  corpo: string;
}

function criarHarness(env: NodeJS.ProcessEnv = {}) {
  // Parser REAL do client normaliza os payloads crus da Hinova
  const parser = new SgaBoletoPeriodoClient(
    null as any,
    {
      get: () => ({ quantidadePorPagina: 500, sgaBaseUrl: 'x' }),
    } as any,
  );

  const boletosSga: Record<string, unknown>[] = [];

  // SGA simulado: replica o filtro server-side real (data_vencimento na janela
  // + codigo_situacao_boleto = 2), lendo o estado ATUAL de cada boleto.
  const sgaClient = {
    listarAbertosPorVencimento: jest.fn(
      // eslint-disable-next-line @typescript-eslint/require-await
      async (_tenant: string, ini: Date, fim: Date) => {
        const abertos = boletosSga.filter((b: any) => {
          const venc = parseDateSga(b.data_vencimento);
          return (
            String(b.codigo_situacao_boleto) === '2' &&
            !!venc &&
            venc >= ini &&
            venc <= fim
          );
        });
        const pagina = parser.parsePagina({ boletos: abertos });
        return {
          boletos: pagina.boletos,
          totalRegistros: pagina.boletos.length,
          numeroPaginas: 1,
          paginasConsultadas: 1,
          duplicadosEntrePaginas: 0,
          origem: 'SGA' as const,
        };
      },
    ),
  };

  // Prisma em memória com a unique de idempotência de verdade
  const logs: any[] = [];
  let seq = 0;
  const usuarios: any[] = [];
  const prisma: any = {
    boletoNotificacaoExecucao: {
      create: jest.fn(() => Promise.resolve({ id: ++seq })),
      update: jest.fn(() => Promise.resolve({})),
    },
    boletoNotificacaoLog: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          logs.filter(
            (l) =>
              l.tenant === where.tenant &&
              l.tipoMensagem === where.tipoMensagem &&
              where.dataVencimentoOriginal.in.some(
                (d: Date) => d.getTime() === l.dataVencimentoOriginal.getTime(),
              ) &&
              where.codigoAssociado.in.includes(l.codigoAssociado),
          ),
        ),
      ),
      create: jest.fn(({ data }: any) => {
        const duplicado = logs.some(
          (l) =>
            l.tenant === data.tenant &&
            l.codigoAssociado === data.codigoAssociado &&
            l.tipoMensagem === data.tipoMensagem &&
            l.dataVencimentoOriginal.getTime() ===
              data.dataVencimentoOriginal.getTime(),
        );
        if (duplicado) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('unique', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          );
        }
        const row = { id: ++seq, ...data };
        logs.push(row);
        return Promise.resolve({ id: row.id });
      }),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({})),
    },
    user: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          usuarios.filter((u) => u.isActive && where.cpf.in.includes(u.cpf)),
        ),
      ),
      updateMany: jest.fn(() => Promise.resolve({})),
    },
    notification: { createMany: jest.fn(() => Promise.resolve({ count: 0 })) },
  };

  const service = new BoletoNotificacaoService(
    prisma,
    { get: () => loadBoletoNotificacaoConfig(env) } as any,
    sgaClient as any,
    { add: jest.fn(() => Promise.resolve({ id: 'job' })) } as any,
  );

  // Expo mockado: captura em vez de enviar
  const pushes: PushCapturado[] = [];
  let diaAtual = '';
  const tokenPorCpf = new Map<string, string>();
  (service as any).expo = {
    chunkPushNotifications: (msgs: unknown[]) => [msgs],
    sendPushNotificationsAsync: jest.fn((msgs: any[]) => {
      msgs.forEach((m) => {
        const cpf =
          Array.from(tokenPorCpf.entries()).find(([, t]) => t === m.to)?.[0] ??
          '?';
        pushes.push({
          dia: diaAtual,
          tipo: m.data.tipoMensagem,
          cpf,
          titulo: m.title,
          corpo: m.body,
        });
      });
      return Promise.resolve(
        msgs.map((_, i) => ({ status: 'ok', id: `t${i}` })),
      );
    }),
  };

  return {
    boletosSga,
    usuarios,
    logs,
    pushes,
    /** Roda a régua completa (6 etapas) para um dia, como o cron faria. */
    async rodarDia(dia: Date) {
      diaAtual = formatDateISO(dia);
      return service.executarRotina({
        dataReferencia: dia,
        tenants: ['MAIS_PRIME'],
      });
    },
    async rodarPeriodo(inicio: Date, fim: Date) {
      for (let d = new Date(inicio); d <= fim; d = addDays(d, 1)) {
        await this.rodarDia(d);
      }
    },
    registrarUsuario(cpf: string, extras: Record<string, unknown> = {}) {
      const token = `ExponentPushToken[${cpf.padStart(22, 'x').slice(0, 22)}]`;
      tokenPorCpf.set(cpf, token);
      usuarios.push({
        id: usuarios.length + 1,
        cpf,
        isActive: true,
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: token,
        ...extras,
      });
    },
  };
}

const resumo = (p: PushCapturado[]) => p.map((x) => `${x.dia}:${x.tipo}`);

// ── Cenários ──────────────────────────────────────────────────────────────────

describe('Régua v2 — cenários com boletos reais da Hinova (sem envio real)', () => {
  it('JORNADA COMPLETA sem pagamento: exatamente 6 pushes nos dias certos, de 02/09 a 10/10', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(boletoKaio()); // gerado 02/09, vence 15/09, nunca pago

    await h.rodarPeriodo(new Date(2026, 8, 2), new Date(2026, 9, 10));

    // 39 dias × 6 etapas = 234 execuções; só estes 6 pushes podem existir:
    expect(resumo(h.pushes)).toEqual([
      '2026-09-10:DM5', // 1º dia em que 15/09 entra na janela D-5..D-1
      '2026-09-15:D0',
      '2026-09-16:D1',
      '2026-09-20:D5',
      '2026-09-21:D6',
      '2026-10-05:D20', // última mensagem da régua
    ]);
    // Textos oficiais renderizados com os dados reais do boleto
    expect(h.pushes[1].titulo).toBe('Seu boleto vence hoje');
    expect(h.pushes[1].corpo).toBe(
      'Kaio, o boleto da proteção do TTK3D73 vence hoje. Pague em poucos toques pelo app e siga tranquilo.',
    );
    expect(h.pushes[0].corpo).toContain('vence em 15/09');
    expect(h.pushes[0].titulo).toBe('Seu boleto de Setembro já está no app');
  });

  it('PAGAMENTO no D+1 à noite (baixa no SGA dia 17/09): D+5/D+6/D+20 NUNCA saem', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    const boleto = boletoKaio();
    h.boletosSga.push(boleto);

    await h.rodarPeriodo(new Date(2026, 8, 2), new Date(2026, 8, 16));
    // baixa registrada no SGA antes da rotina de 17/09
    boleto.codigo_situacao_boleto = '1';
    boleto.situacao_boleto = 'BAIXADO';
    await h.rodarPeriodo(new Date(2026, 8, 17), new Date(2026, 9, 10));

    expect(resumo(h.pushes)).toEqual([
      '2026-09-10:DM5',
      '2026-09-15:D0',
      '2026-09-16:D1',
    ]);
  });

  it('PAGAMENTO antes do vencimento (baixa 12/09): só a D-5 sai; D0 não', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    const boleto = boletoKaio();
    h.boletosSga.push(boleto);

    await h.rodarPeriodo(new Date(2026, 8, 2), new Date(2026, 8, 11));
    boleto.codigo_situacao_boleto = '1';
    await h.rodarPeriodo(new Date(2026, 8, 12), new Date(2026, 9, 10));

    expect(resumo(h.pushes)).toEqual(['2026-09-10:DM5']);
  });

  it('CANCELADO (3) e BAIXADO C/ PENDÊNCIA (4): nenhum push em nenhuma etapa', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.registrarUsuario('58034733000127');
    h.boletosSga.push(
      boletoKaio({ codigo_situacao_boleto: '3', situacao_boleto: 'CANCELADO' }),
      boletoLocadora({ codigo_situacao_boleto: '4' }),
    );

    await h.rodarPeriodo(new Date(2026, 8, 2), new Date(2026, 9, 10));
    expect(h.pushes).toEqual([]);
  });

  it('REGRA GLOBAL (catch-up): boleto velho ABERTO (venc. 15/08, real do Kaio) recebe D+20 uma única vez ao entrar na régua', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      boletoKaio({
        nosso_numero: 3397456,
        data_vencimento: '2026-08-15',
        data_vencimento_original: '2026-08-15',
        mes_referente: '08/2026',
      }),
    );

    // Em 10/09 ele está em D+26 → faixa do D+20 (20..60): recebe 1 vez e só
    await h.rodarPeriodo(new Date(2026, 8, 10), new Date(2026, 9, 10));
    expect(resumo(h.pushes)).toEqual(['2026-09-10:D20']);
    expect(h.pushes[0].titulo).toBe(
      'Último dia para reativar sem nova vistoria',
    );
  });

  it('REGRA GLOBAL (catch-up): boleto que entra atrasado recebe só a etapa da faixa atual, depois escala', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      boletoKaio({
        data_vencimento: '2026-09-01',
        data_vencimento_original: '2026-09-01',
      }),
    );

    // 1ª execução em 11/09 → atraso 10 → APENAS D+6 (sem D0/D+1/D+5 retroativos)
    // Em 21/09 → atraso 20 → escala para D+20; nada além disso até 10/10
    await h.rodarPeriodo(new Date(2026, 8, 11), new Date(2026, 9, 10));
    expect(resumo(h.pushes)).toEqual(['2026-09-11:D6', '2026-09-21:D20']);
    expect(h.pushes[0].titulo).toBe('Seu veículo está sem proteção');
  });

  it('FIM DE SEMANA: venc. original 19/09 (sáb) prorrogado pelo SGA para 21/09 → D0 sai dia 21, nada dias 19/20', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      boletoKaio({
        data_vencimento_original: '2026-09-19',
        data_vencimento: '2026-09-21', // como o SGA devolve (D = próximo dia útil)
      }),
    );

    await h.rodarPeriodo(new Date(2026, 8, 14), new Date(2026, 8, 22));
    expect(resumo(h.pushes)).toEqual([
      '2026-09-16:DM5', // janela D-5 do vencimento EFETIVO (21/09)
      '2026-09-21:D0',
      '2026-09-22:D1',
    ]);
  });

  it('IDEMPOTÊNCIA: rodar a régua duas vezes no mesmo dia não duplica nenhum push', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      boletoKaio({
        data_vencimento: '2026-09-10',
        data_vencimento_original: '2026-09-10',
      }),
    );

    await h.rodarDia(new Date(2026, 8, 10));
    await h.rodarDia(new Date(2026, 8, 10)); // reexecução (retry/manual)

    expect(resumo(h.pushes)).toEqual(['2026-09-10:D0']);
  });

  it('SEM APP / SEM TOKEN / OUTRO TENANT: boleto elegível mas nenhum push equivocado', async () => {
    const h = criarHarness();
    // 3 boletos ABERTOS vencendo hoje, nenhum destinatário válido:
    h.boletosSga.push(
      boletoKaio({ codigo_associado: 1, cpf: '11111111111' }), // sem cadastro no app
      boletoKaio({ codigo_associado: 2, cpf: '22222222222' }), // sem token
      boletoKaio({ codigo_associado: 3, cpf: '33333333333' }), // tenant RS
    );
    h.usuarios.push(
      {
        id: 90,
        cpf: '22222222222',
        isActive: true,
        baseOrigin: 'MAIS_PRIME',
        expoPushToken: null,
      },
      {
        id: 91,
        cpf: '33333333333',
        isActive: true,
        baseOrigin: 'MAIS_PRIME_RS',
        expoPushToken: 'ExponentPushToken[cccccccccccccccccccccc]',
      },
    );

    await h.rodarDia(new Date(2026, 8, 15));
    expect(h.pushes).toEqual([]);
  });

  it('CNPJ (locadora real): push vai para o usuário com o CNPJ, e um CPF parecido não recebe', async () => {
    const h = criarHarness();
    h.registrarUsuario('58034733000127'); // usuário da locadora
    h.registrarUsuario('34733000127'); // CPF diferente — não pode receber
    h.boletosSga.push(boletoLocadora());

    await h.rodarDia(new Date(2026, 8, 15));

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0].cpf).toBe('58034733000127');
    expect(h.pushes[0].corpo).toContain('Letamotos');
  });

  it('MÚLTIPLOS BOLETOS do mesmo associado no mesmo vencimento: um único push agregado', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      boletoKaio({ nosso_numero: 111 }),
      boletoKaio({ nosso_numero: 222 }),
    );

    await h.rodarDia(new Date(2026, 8, 15));
    expect(h.pushes).toHaveLength(1);
  });

  it('QUITAÇÃO reemitida (real): dispara D0 no vencimento efetivo por default; filtrável por tipo de boleto', async () => {
    // Default (sem filtro): boleto ABERTO com venc. efetivo 15/09 → recebe D0
    const h1 = criarHarness();
    h1.registrarUsuario('06380048707');
    h1.boletosSga.push(boletoQuitacao());
    await h1.rodarDia(new Date(2026, 8, 15));
    expect(resumo(h1.pushes)).toEqual(['2026-09-15:D0']);

    // Com BOLETO_NOTIFICACAO_CODIGOS_TIPO_BOLETO=1,5 a quitação (27) fica fora
    const h2 = criarHarness({ BOLETO_NOTIFICACAO_CODIGOS_TIPO_BOLETO: '1,5' });
    h2.registrarUsuario('06380048707');
    h2.boletosSga.push(boletoQuitacao());
    await h2.rodarDia(new Date(2026, 8, 15));
    expect(h2.pushes).toEqual([]);
  });

  it('REGRA DA PLACA (caso real do Kaio): dois fechamentos ABERTOS da mesma placa → só o mais recente entra na régua', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      // venc. 15/08 (antigo, ABERTO) e venc. 15/09 — MESMA placa TTK3D73
      boletoKaio({
        nosso_numero: 3397456,
        data_vencimento: '2026-08-15',
        data_vencimento_original: '2026-08-15',
        mes_referente: '08/2026',
      }),
      boletoKaio(), // venc. 15/09
    );

    await h.rodarPeriodo(new Date(2026, 8, 10), new Date(2026, 9, 10));

    // O de 15/08 é ignorado por completo (nem o catch-up D+20);
    // o de 15/09 segue a jornada normal do PDF:
    expect(resumo(h.pushes)).toEqual([
      '2026-09-10:DM5',
      '2026-09-15:D0',
      '2026-09-16:D1',
      '2026-09-20:D5',
      '2026-09-21:D6',
      '2026-10-05:D20',
    ]);
  });

  it('REGRA DA PLACA: placas diferentes do mesmo associado NÃO se anulam', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729');
    h.boletosSga.push(
      boletoKaio({
        nosso_numero: 111,
        data_vencimento: '2026-09-01',
        data_vencimento_original: '2026-09-01',
        veiculos: [
          { codigo_veiculo: 1, placa: 'AAA1A11', situacao_veiculo: 'ATIVO' },
        ],
      }),
      boletoKaio({ nosso_numero: 222 }), // venc. 15/09, placa TTK3D73
    );

    await h.rodarDia(new Date(2026, 8, 11)); // atraso 10 do 1º + D-4 do 2º
    // Cada placa segue sua própria régua: o de 15/09 recebe a D-5 (1ª vez na
    // janela) e o de 01/09 recebe o catch-up D+6 — nenhum anula o outro
    expect(resumo(h.pushes)).toEqual(['2026-09-11:DM5', '2026-09-11:D6']);
  });

  it('CALENDÁRIO CHEIO: coortes 10 e 15 juntas — cada uma recebe apenas as suas etapas', async () => {
    const h = criarHarness();
    h.registrarUsuario('18886548729'); // coorte 15
    h.registrarUsuario('58034733000127'); // coorte 10
    h.boletosSga.push(
      boletoKaio(), // vence 15/09
      boletoLocadora({
        data_vencimento: '2026-09-10',
        data_vencimento_original: '2026-09-10',
      }),
    );

    await h.rodarPeriodo(new Date(2026, 8, 4), new Date(2026, 8, 21));

    const porCpf = (cpf: string) =>
      resumo(h.pushes.filter((p) => p.cpf === cpf));
    expect(porCpf('58034733000127')).toEqual([
      '2026-09-05:DM5',
      '2026-09-10:D0',
      '2026-09-11:D1',
      '2026-09-15:D5',
      '2026-09-16:D6',
    ]);
    expect(porCpf('18886548729')).toEqual([
      '2026-09-10:DM5',
      '2026-09-15:D0',
      '2026-09-16:D1',
      '2026-09-20:D5',
      '2026-09-21:D6',
    ]);
  });
});
