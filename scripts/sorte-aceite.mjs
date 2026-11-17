#!/usr/bin/env node
/**
 * Roteiro de aceite do Associado da Sorte v2 contra uma API LOCAL já no ar.
 *
 * Exercita, pelas rotas HTTP reais (painel + app), os critérios da seção 4 de
 * docs/ASSOCIADO_DA_SORTE_V2_PROMPT.md que dá para testar sem tela, com o
 * relógio real. Onde o critério depende de tempo (intervalo de 60 min, virada
 * do dia, jornada de 3 dias), o script ajusta datas de raspadas no BANCO LOCAL
 * via Prisma — só dos usuários de aceite que ele mesmo cria.
 *
 *   1. inscrição: marcação manual, NAO_INSCRITO e participante único
 *      (a regra do produto 3677 no SGA é coberta pelos testes unitários);
 *   2. base MAIS_PRIME_RS vê a promoção inativa;
 *   3. raspadasPorDia = 2 / intervalo 60 min: INTERVALO, LIMITE_DIARIO, virada;
 *   4. momento futuro não sai antes da hora; sai depois; o de ontem sai hoje;
 *   5. 10 raspadas simultâneas com 1 momento → 1 ganhador, crédito uma vez;
 *   6. campanha publicada recusa edição; exportação traz o mesmo hash;
 *   7. loja: débito, estoque, notificação, e-mail enfileirado, wa.me do
 *      marketing, limite, saldo, estoque 1 com duas compras simultâneas;
 *   8. lembrete: uma vez por liberação e nada fora da janela;
 *   9. jornada com marco de 3 dias: bônus uma vez; desligada, nenhum;
 *  10. não inscrito recebe o convite (wa.me + mensagem) no resumo;
 *  11. painel mostra raspadas e tentativas que falharam do associado;
 *  12. rodadasHabilitadas = false → rotas de rodada do app respondem 404.
 *
 * Efeitos: encerra a campanha publicada da MAIS_PRIME, publica e encerra uma
 * "Campanha (aceite)", cria usuários "Aceite NN" (CPF 900000009NN) e
 * produtos "(aceite)" (retirados da loja no fim). No fim restaura a
 * configuração e roda `npm run sorte:seed-demo` para publicar de novo a
 * campanha de demonstração (SORTE_ACEITE_SEM_SEED=1 pula).
 *
 * Pré-requisitos: API no ar, `npm run sorte:seed-demo` já executado.
 *
 * Uso (o .env é necessário para o Prisma local):
 *   node --env-file=.env scripts/sorte-aceite.mjs
 *   API_URL=http://localhost:3001/api node --env-file=.env scripts/sorte-aceite.mjs
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as esperar } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const API = (process.env.API_URL || 'http://localhost:3001/api').replace(
  /\/$/,
  '',
);
const SENHA = process.env.SORTE_DEMO_SENHA || 'Demo@1234';
const EMAIL = process.env.SORTE_DEMO_EMAIL || 'marketing.demo@maisprime.local';
const BASE = 'MAIS_PRIME';
const EMAIL_ACEITE = 'aceite.sorte@example.com';
const WHATS_MARKETING = '5500000000099';
const TOTAL_USUARIOS = 15;

const dbUrl = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(dbUrl)) {
  console.error(
    'DATABASE_URL não aponta para um banco local (ou não foi carregado: use node --env-file=.env). Abortado.',
  );
  process.exit(2);
}
if (!/localhost|127\.0\.0\.1/.test(API)) {
  console.error(`API_URL não é local (${API}). Abortado.`);
  process.exit(2);
}

const prisma = new PrismaClient();

// ------------------------------------------------------------------ util

let falhas = 0;
let total = 0;
const resultadoPorCriterio = new Map();
let criterioAtual = '';
function conferir(descricao, condicao, detalhe = '') {
  total++;
  const r = resultadoPorCriterio.get(criterioAtual) ?? { ok: 0, falhou: 0 };
  if (condicao) {
    r.ok++;
    console.log(`  ✔ ${descricao}`);
  } else {
    falhas++;
    r.falhou++;
    console.log(`  ✖ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
  }
  resultadoPorCriterio.set(criterioAtual, r);
}
function secao(titulo) {
  criterioAtual = titulo;
  console.log(`\n■ ${titulo}`);
}

async function chamar(metodo, rota, { token, corpo, texto } = {}) {
  const resposta = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const bruto = await resposta.text();
  if (texto) return { status: resposta.status, dados: bruto };
  let dados = null;
  try {
    dados = bruto ? JSON.parse(bruto) : null;
  } catch {
    dados = bruto;
  }
  return { status: resposta.status, dados };
}

const FORMATO_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const FORMATO_HORA = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const diaSP = (d = new Date()) => FORMATO_DIA.format(d);
const somarDias = (dia, n) => {
  const d = new Date(`${dia}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const viradaSP = (d = new Date()) =>
  new Date(`${somarDias(diaSP(d), 1)}T00:00:00.000-03:00`);
const horaSP = (d) => FORMATO_HORA.format(d);
async function esperarAte(instante, folgaMs = 400) {
  const ms = instante.getTime() - Date.now() + folgaMs;
  if (ms > 0) {
    console.log(`  … aguardando ${Math.ceil(ms / 1000)} s`);
    await esperar(ms);
  }
}

// ---------------------------------------------------------------- roteiro

async function main() {
  secao('Preparação');
  const loginPainel = await chamar('POST', '/admin-panel/auth/login', {
    corpo: { email: EMAIL, password: SENHA },
  });
  const admin = loginPainel.dados?.access_token;
  conferir(
    'login no painel (MARKETING)',
    !!admin && loginPainel.dados?.user?.role === 'MARKETING',
    `status ${loginPainel.status}`,
  );
  if (!admin) throw new Error('Sem token do painel: rode npm run sorte:seed-demo.');
  const P = (metodo, rota, corpo, extra) =>
    chamar(metodo, `/admin/associado-sorte${rota}`, {
      token: admin,
      corpo,
      ...extra,
    });

  const configOriginal = (await P('GET', `/config/${BASE}`)).dados;

  // Usuários de aceite (MAIS_PRIME, inscritos à mão), sem raspadas de hoje.
  const hash = await bcrypt.hash(SENHA, 10);
  const usuarios = [];
  for (let i = 1; i <= TOTAL_USUARIOS; i++) {
    const cpf = `900000009${String(i).padStart(2, '0')}`;
    const u = await prisma.user.upsert({
      where: { cpf },
      update: { isActive: true, baseOrigin: BASE, expoPushToken: null },
      create: {
        name: `Aceite ${String(i).padStart(2, '0')} Sorte`,
        cpf,
        email: `aceite${i}@example.com`,
        passwordHash: hash,
        baseOrigin: BASE,
        isActive: true,
        primeiroLogin: false,
      },
    });
    await prisma.sorteInscricao.upsert({
      where: { userId: u.id },
      update: { inscrito: true, fonte: 'MANUAL', baseOrigin: BASE },
      create: {
        userId: u.id,
        inscrito: true,
        fonte: 'MANUAL',
        baseOrigin: BASE,
        autorNome: 'Roteiro de aceite',
      },
    });
    usuarios.push({ id: u.id, cpf });
  }
  const ids = usuarios.map((u) => u.id);
  await prisma.sorteRaspada.deleteMany({ where: { userId: { in: ids } } });
  await prisma.sorteCarteira.updateMany({
    where: { userId: { in: ids } },
    data: { sequenciaDias: 0, ultimoDiaColetado: null, lembreteRaspadaEm: null },
  });
  for (const u of usuarios) {
    const r = await chamar('POST', '/auth/login', {
      corpo: { cpf: u.cpf, password: SENHA },
    });
    u.token = r.dados?.access_token;
  }
  conferir(
    `${TOTAL_USUARIOS} associados de aceite autenticados`,
    usuarios.every((u) => !!u.token),
  );
  const A = (u, metodo, rota, corpo) =>
    chamar(metodo, `/associado-sorte${rota}`, { token: u.token, corpo });
  const saldo = async (u) => (await A(u, 'GET', '/resumo')).dados?.saldo ?? 0;

  const salvarConfig = (corpo) => P('PUT', `/config/${BASE}`, corpo);
  const cfg = await salvarConfig({
    ativa: true,
    raspadasPorDia: 10,
    intervaloMinimoMinutos: 0,
    carenciaDias: 0,
    jornadaAtiva: false,
    lembretesAtivos: false,
    rodadasHabilitadas: false,
    emailNotificacoes: EMAIL_ACEITE,
    whatsappMarketing: WHATS_MARKETING,
    whatsappConvite: '5500000000000',
  });
  conferir('configuração v2 gravada pelo painel', cfg.status === 200, JSON.stringify(cfg.dados));

  // Campanha de aceite: encerra a publicada (a do seed volta no fim).
  const publicadas = await P('GET', `/campanhas?baseOrigin=${BASE}&estado=PUBLICADA`);
  for (const c of publicadas.dados?.data ?? []) {
    await P('POST', `/campanhas/${c.id}/encerrar`, {
      motivo: 'Encerrada pelo roteiro de aceite (o seed publica outra)',
    });
  }

  const agora = new Date();
  const criada = await P('POST', '/campanhas', {
    baseOrigin: BASE,
    nome: `Campanha (aceite) ${horaSP(agora)}`,
    inicio: new Date(agora.getTime() - 2 * 86_400_000).toISOString(),
    fim: new Date(agora.getTime() + 86_400_000).toISOString(),
  });
  const campanha = criada.dados;
  conferir('campanha criada em rascunho', criada.status === 201 && campanha?.estado === 'RASCUNHO', JSON.stringify(criada.dados));

  // CSV: pré-visualização com erro por linha, sem gravar.
  const ontem = somarDias(diaSP(agora), -1).split('-').reverse().join('/');
  const prev = await P('POST', `/campanhas/${campanha.id}/cronograma/pre-visualizar`, {
    csv: `data;hora;creditos;descricao\n${ontem};15:00;120;Voucher de ontem\n${ontem};25:00;100;hora errada\n${ontem};15:00;120;Voucher de ontem`,
  });
  conferir(
    'pré-visualização do CSV aponta erros por linha (hora inválida, duplicada)',
    prev.dados?.validas === 1 &&
      prev.dados?.erros?.map((e) => e.linha).join(',') === '3,4',
    JSON.stringify(prev.dados?.erros),
  );
  const imp = await P('POST', `/campanhas/${campanha.id}/cronograma/importar`, {
    csv: `data;hora;creditos;descricao\n${ontem};15:00;120;Voucher de ontem`,
  });
  conferir('importação grava o momento de ontem às 15:00', imp.dados?.criados === 1, JSON.stringify(imp.dados));

  const tMomento = new Date(Date.now() + 50_000);
  const tConcorrencia = new Date(Date.now() + 80_000);
  await P('POST', `/campanhas/${campanha.id}/momentos`, {
    liberaEm: tMomento.toISOString(),
    creditos: 150,
    descricao: 'Momento das HH:MM (aceite)',
  });
  await P('POST', `/campanhas/${campanha.id}/momentos`, {
    liberaEm: tConcorrencia.toISOString(),
    creditos: 200,
    descricao: 'Momento da concorrência (aceite)',
  });
  const errada = await P('POST', `/campanhas/${campanha.id}/publicar`, {
    confirmacao: 'nome errado',
  });
  conferir('publicar exige digitar o nome', errada.dados?.code === 'CONFIRMACAO_INVALIDA');
  const pub = await P('POST', `/campanhas/${campanha.id}/publicar`, {
    confirmacao: campanha.nome,
  });
  conferir(
    'campanha publicada e travada com hash SHA-256',
    pub.dados?.estado === 'PUBLICADA' && /^[0-9a-f]{64}$/.test(pub.dados?.hashCronograma ?? ''),
    JSON.stringify(pub.dados),
  );

  const [U0, U1, U2] = usuarios;

  // ---------------------------------------------------------------- 4
  secao('4. Momento: não sai antes da hora; sai depois; o de ontem sai hoje');
  const r0 = await A(U0, 'POST', '/raspar');
  conferir(
    'momento não ganho ontem sai hoje (primeira raspada leva o voucher de 120)',
    r0.dados?.resultado === 'GANHOU' && r0.dados?.creditos === 120,
    JSON.stringify(r0.dados),
  );
  const r1 = await A(U1, 'POST', '/raspar');
  conferir(
    `raspada antes de ${horaSP(tMomento)} (servidor ${r1.dados?.serverNow}) não ganha`,
    r1.dados?.resultado === 'NAO_GANHOU' &&
      new Date(r1.dados?.serverNow) < tMomento,
    JSON.stringify(r1.dados),
  );
  await esperarAte(tMomento);
  const r2 = await A(U2, 'POST', '/raspar');
  conferir(
    'a primeira raspada depois do horário ganha o voucher de 150',
    r2.dados?.resultado === 'GANHOU' && r2.dados?.creditos === 150,
    JSON.stringify(r2.dados),
  );

  // ---------------------------------------------------------------- 5
  secao('5. Concorrência: 10 raspadas simultâneas com 1 momento liberado');
  const grupo = usuarios.slice(2, 12);
  const antes = await Promise.all(grupo.map(saldo));
  await esperarAte(tConcorrencia);
  const simultaneas = await Promise.all(grupo.map((u) => A(u, 'POST', '/raspar')));
  const ganhadoras = simultaneas.filter((r) => r.dados?.resultado === 'GANHOU');
  conferir(
    `10 respostas 200, exatamente 1 ganhou (${ganhadoras.length})`,
    simultaneas.every((r) => r.status === 200) && ganhadoras.length === 1,
    simultaneas.map((r) => `${r.status}:${r.dados?.resultado ?? r.dados?.code}`).join(' '),
  );
  const depois = await Promise.all(grupo.map(saldo));
  const somaDelta = depois.reduce((s, v, i) => s + v - antes[i], 0);
  conferir('saldo creditado uma única vez (soma das variações = 200)', somaDelta === 200, `delta ${somaDelta}`);
  const momentoConc = await prisma.sorteMomentoPremiado.findFirst({
    where: { campanhaId: campanha.id, creditos: 200 },
  });
  const lancamentos = await prisma.sorteCreditoLancamento.count({
    where: {
      userId: { in: grupo.map((u) => u.id) },
      tipo: 'VOUCHER_RASPADINHA',
      valor: 200,
      createdAt: { gte: tConcorrencia },
    },
  });
  conferir('um lançamento VOUCHER_RASPADINHA e o momento com um ganhador', lancamentos === 1 && !!momentoConc?.userId);

  // ---------------------------------------------------------------- 6
  secao('6. Campanha publicada recusa edição; exportação traz o mesmo hash');
  const momentos = await P('GET', `/campanhas/${campanha.id}/momentos?limit=10`);
  const umMomento = momentos.dados?.data?.[0];
  conferir(
    'lista de momentos com status e ganhador',
    momentos.dados?.data?.length === 3 &&
      momentos.dados.data.filter((m) => m.status === 'GANHO').length === 3 &&
      !!umMomento?.ganhador?.cpfMascarado,
    JSON.stringify(momentos.dados?.data?.map((m) => m.status)),
  );
  const tentativasEdicao = await Promise.all([
    P('POST', `/campanhas/${campanha.id}/momentos`, {
      liberaEm: new Date(Date.now() + 3_600_000).toISOString(),
      creditos: 1,
    }),
    P('PATCH', `/campanhas/${campanha.id}/momentos/${umMomento?.id}`, { creditos: 1 }),
    P('DELETE', `/campanhas/${campanha.id}/momentos/${umMomento?.id}`),
    P('PATCH', `/campanhas/${campanha.id}`, {
      fim: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    }),
    P('POST', `/campanhas/${campanha.id}/cronograma/importar`, {
      csv: 'data;hora;creditos\n01/01/2030;10:00;1',
    }),
  ]);
  conferir(
    'criar/editar/apagar momento, mudar o fim e importar → 409 CAMPANHA_TRAVADA',
    tentativasEdicao.every((r) => r.status === 409 && r.dados?.code === 'CAMPANHA_TRAVADA'),
    tentativasEdicao.map((r) => `${r.status}:${r.dados?.code}`).join(' '),
  );
  const auditoria = await P('GET', `/campanhas/${campanha.id}/auditoria`, undefined, { texto: true });
  const csv = String(auditoria.dados);
  conferir(
    'exportação de auditoria traz o hash da publicação e confere',
    auditoria.status === 200 &&
      csv.includes(`hash_cronograma_sha256;${pub.dados?.hashCronograma}`) &&
      csv.includes('hash_confere;SIM'),
  );
  conferir(
    'auditoria lista os momentos com ganhador (CPF mascarado) e as raspadas',
    /\*\*\*\.\d{3}\.\d{3}-\*\*/.test(csv) && csv.includes('RASPADAS') && csv.split('\n').length > 20,
  );

  // ---------------------------------------------------------------- 3
  secao('3. raspadasPorDia = 2, intervalo 60 min, virada do dia em São Paulo');
  await salvarConfig({ raspadasPorDia: 2, intervaloMinimoMinutos: 60 });
  const U12 = usuarios[12];
  const a1 = await A(U12, 'POST', '/raspar');
  conferir('primeira raspada do dia', a1.status === 200 && a1.dados?.raspadasRestantesHoje === 1, JSON.stringify(a1.dados));
  const a2 = await A(U12, 'POST', '/raspar');
  const esperado = new Date(new Date(a1.dados?.serverNow).getTime() + 60 * 60_000);
  conferir(
    'segunda raspada antes de 60 min → 409 INTERVALO com proximaRaspadaEm',
    a2.status === 409 &&
      a2.dados?.code === 'INTERVALO' &&
      Math.abs(new Date(a2.dados?.proximaRaspadaEm) - esperado) < 5_000,
    JSON.stringify(a2.dados),
  );
  // Simula "60 min depois" no banco local.
  await prisma.$executeRaw`UPDATE SorteRaspada SET createdAt = DATE_SUB(createdAt, INTERVAL 61 MINUTE) WHERE userId = ${U12.id}`;
  const a3 = await A(U12, 'POST', '/raspar');
  conferir('depois do intervalo a segunda raspada passa', a3.status === 200 && a3.dados?.raspadasRestantesHoje === 0, JSON.stringify(a3.dados));
  await prisma.$executeRaw`UPDATE SorteRaspada SET createdAt = DATE_SUB(createdAt, INTERVAL 61 MINUTE) WHERE userId = ${U12.id}`;
  const a4 = await A(U12, 'POST', '/raspar');
  conferir(
    'terceira no dia → 409 LIMITE_DIARIO, próxima à 00:00 de São Paulo',
    a4.status === 409 &&
      a4.dados?.code === 'LIMITE_DIARIO' &&
      new Date(a4.dados?.proximaRaspadaEm).getTime() === viradaSP().getTime(),
    JSON.stringify(a4.dados),
  );
  // Simula a virada: as raspadas passam a ser de ontem.
  const ontemDia = new Date(`${somarDias(diaSP(), -1)}T00:00:00.000Z`);
  await prisma.$executeRaw`UPDATE SorteRaspada SET dia = ${ontemDia}, createdAt = DATE_SUB(createdAt, INTERVAL 1 DAY) WHERE userId = ${U12.id}`;
  const resumoVirada = await A(U12, 'GET', '/resumo');
  conferir(
    'depois da 00:00 o contador volta a 2, sem acumular',
    resumoVirada.dados?.raspadinha?.raspadasHoje === 0 &&
      resumoVirada.dados?.raspadinha?.raspadasRestantesHoje === 2 &&
      resumoVirada.dados?.raspadinha?.disponivel === true,
    JSON.stringify(resumoVirada.dados?.raspadinha),
  );

  // ---------------------------------------------------------------- 9
  secao('9. Jornada com marco de 3 dias');
  await salvarConfig({
    raspadasPorDia: 10,
    intervaloMinimoMinutos: 0,
    jornadaAtiva: true,
    marcosSequencia: [{ dias: 3, bonus: 25 }],
  });
  const [U13, U14] = [usuarios[13], usuarios[14]];
  for (const u of [U13, U14]) {
    await prisma.sorteCarteira.upsert({
      where: { userId: u.id },
      update: { sequenciaDias: 2, ultimoDiaColetado: ontemDia },
      create: { userId: u.id, baseOrigin: BASE, sequenciaDias: 2, ultimoDiaColetado: ontemDia },
    });
  }
  const j1 = await A(U13, 'POST', '/raspar');
  const j2 = await A(U13, 'POST', '/raspar');
  conferir(
    'ligada: terceiro dia seguido credita o bônus de 25 uma vez',
    j1.dados?.bonusJornada === 25 && j1.dados?.jornada?.sequencia === 3 && j2.dados?.bonusJornada === 0,
    `${JSON.stringify(j1.dados?.jornada)} / ${j2.dados?.bonusJornada}`,
  );
  await salvarConfig({ jornadaAtiva: false });
  const j3 = await A(U14, 'POST', '/raspar');
  const resumoSemJornada = await A(U14, 'GET', '/resumo');
  conferir(
    'desligada: nenhum bônus e nada de jornada no resumo',
    j3.dados?.bonusJornada === 0 && j3.dados?.jornada === null && resumoSemJornada.dados?.jornada === null,
    JSON.stringify(j3.dados),
  );

  // ---------------------------------------------------------------- 7
  secao('7. Loja da Sorte');
  const produto = async (corpo) =>
    (await P('POST', '/premios', {
      descricao: 'Criado pelo roteiro de aceite.',
      naLoja: true,
      tipo: 'FISICO',
      instrucoesRetirada: 'Retire na sede com o código do pedido.',
      ...corpo,
    })).dados;
  const hora = horaSP(new Date());
  const pLimite = await produto({ nome: `Kit (aceite ${hora})`, custoCreditos: 30, estoqueInicial: 5, limitePorAssociado: 1, tipo: 'SERVICO_MAIS_PRIME' });
  const pUnico = await produto({ nome: `Unidade única (aceite ${hora})`, custoCreditos: 20, estoqueInicial: 1, tipo: 'CUPOM_PARCEIRO' });
  const pCaro = await produto({ nome: `Caro demais (aceite ${hora})`, custoCreditos: 1_000_000, estoqueInicial: 5 });
  const semPreco = await P('POST', '/premios', { nome: 'Sem preço (aceite)', naLoja: true, custoCreditos: 0 });
  conferir('produto na loja sem preço → 422 CUSTO_INVALIDO', semPreco.dados?.code === 'CUSTO_INVALIDO');

  const loja = await A(U0, 'GET', '/loja');
  conferir(
    'GET /loja lista os produtos com tipo, custo e estoque',
    loja.dados?.produtos?.some((p) => p.id === pLimite.id && p.custoCreditos === 30 && p.tipo === 'SERVICO_MAIS_PRIME'),
  );
  const saldoAntes = await saldo(U0);
  const compra = await A(U0, 'POST', `/loja/${pLimite.id}/comprar`);
  conferir(
    'compra debita, devolve o pedido com código e instruções',
    compra.status === 200 &&
      compra.dados?.saldo === saldoAntes - 30 &&
      compra.dados?.pedido?.origem === 'LOJA' &&
      /^[A-Z2-9]{6}$/.test(compra.dados?.pedido?.codigo ?? '') &&
      compra.dados?.pedido?.instrucoesRetirada === 'Retire na sede com o código do pedido.',
    JSON.stringify(compra.dados),
  );
  const detalhe = (await P('GET', `/premios/${pLimite.id}`)).dados;
  conferir('estoque baixou para 4', detalhe?.estoque === 4);
  const notifs = await P('GET', `/notificacoes?lida=false&baseOrigin=${BASE}&limit=20`);
  const retirada = notifs.dados?.data?.find((n) => n.ganhadorId === compra.dados?.pedido?.id);
  conferir('notificação NOVA_RETIRADA no painel', retirada?.tipo === 'NOVA_RETIRADA', JSON.stringify(retirada));
  conferir(
    `e-mail enfileirado para emailNotificacoes (${EMAIL_ACEITE})`,
    retirada?.email?.destinatarios?.join(',') === EMAIL_ACEITE &&
      ['PENDENTE', 'ENVIADO', 'FALHOU'].includes(retirada?.email?.situacao),
    JSON.stringify(retirada?.email),
  );
  conferir(
    'com whatsappMarketing preenchido a notificação traz o link wa.me',
    (retirada?.linkWhatsappMarketing ?? '').startsWith(`https://wa.me/${WHATS_MARKETING}?text=`),
  );
  const contagem = await P('GET', `/notificacoes/nao-lidas?baseOrigin=${BASE}`);
  conferir('contador de não lidas', contagem.dados?.naoLidas >= 1);
  await salvarConfig({ whatsappMarketing: '' });
  const semWhats = await P('GET', `/notificacoes?lida=false&baseOrigin=${BASE}&limit=20`);
  conferir(
    'com whatsappMarketing vazio o link some',
    semWhats.dados?.data?.find((n) => n.id === retirada?.id)?.linkWhatsappMarketing === null,
  );
  await salvarConfig({ whatsappMarketing: WHATS_MARKETING });

  const limite = await A(U0, 'POST', `/loja/${pLimite.id}/comprar`);
  conferir('limite por associado → 409 LIMITE_POR_ASSOCIADO', limite.status === 409 && limite.dados?.code === 'LIMITE_POR_ASSOCIADO', JSON.stringify(limite.dados));
  const caro = await A(U0, 'POST', `/loja/${pCaro.id}/comprar`);
  conferir('saldo insuficiente → 422 CREDITOS_INSUFICIENTES', caro.status === 422 && caro.dados?.code === 'CREDITOS_INSUFICIENTES');

  for (const u of [U1, U2]) {
    await P('POST', `/associados/${u.id}/creditos`, { valor: 100, motivo: 'Créditos do roteiro de aceite' });
  }
  const duas = await Promise.all([
    A(U1, 'POST', `/loja/${pUnico.id}/comprar`),
    A(U2, 'POST', `/loja/${pUnico.id}/comprar`),
  ]);
  const codigos = duas.map((r) => (r.status === 200 ? 'OK' : r.dados?.code)).sort();
  conferir('estoque 1 com duas compras simultâneas: uma sucede, a outra ESGOTADO', codigos.join(',') === 'ESGOTADO,OK', codigos.join(','));
  const esgotado = (await P('GET', `/notificacoes?tipo=ESTOQUE_ESGOTADO&limit=20`)).dados?.data?.find((n) => n.premioId === pUnico.id);
  conferir('notificação ESTOQUE_ESGOTADO criada', !!esgotado);
  const retiradas = await P('GET', `/ganhadores?origem=LOJA&busca=${compra.dados?.pedido?.codigo}`);
  conferir('Retiradas filtra por origem LOJA', retiradas.dados?.data?.[0]?.origem === 'LOJA' && retiradas.dados.data[0].rodada === null);
  const meus = await A(U0, 'GET', '/meus-premios');
  conferir('pedido aparece em meus-premios', meus.dados?.data?.some((p) => p.id === compra.dados?.pedido?.id));

  await esperar(4_000);
  const emailDepois = (await P('GET', `/notificacoes?baseOrigin=${BASE}&limit=50`)).dados?.data?.find((n) => n.id === retirada?.id);
  conferir(
    `job sorte-email-retirada processado (situação: ${emailDepois?.email?.situacao})`,
    ['ENVIADO', 'FALHOU'].includes(emailDepois?.email?.situacao),
    'ainda PENDENTE depois de 4 s (o job usa 3 tentativas com espera)',
  );

  // ---------------------------------------------------------------- 8
  secao('8. Lembrete: uma vez por liberação e nada fora da janela');
  const agoraL = new Date();
  const dentro = { ini: horaSP(new Date(agoraL.getTime() - 3_600_000)), fim: horaSP(new Date(agoraL.getTime() + 3_600_000)) };
  await prisma.user.update({ where: { id: U14.id }, data: { expoPushToken: 'aceite-token-invalido' } });
  await prisma.sorteCarteira.update({ where: { userId: U14.id }, data: { lembreteRaspadaEm: null } });
  await salvarConfig({ lembretesAtivos: true, lembreteInicio: dentro.ini, lembreteFim: dentro.fim, intervaloMinimoMinutos: 0 });
  await esperar(7_000);
  const l1 = (await prisma.sorteCarteira.findUnique({ where: { userId: U14.id } }))?.lembreteRaspadaEm;
  const ultimaU14 = await prisma.sorteRaspada.findFirst({ where: { userId: U14.id }, orderBy: { createdAt: 'desc' } });
  conferir(
    'dentro da janela: a liberação foi avisada (lembreteRaspadaEm = liberação)',
    !!l1 && Math.abs(l1.getTime() - ultimaU14.createdAt.getTime()) < 1_000,
    String(l1),
  );
  await esperar(6_000);
  const l2 = (await prisma.sorteCarteira.findUnique({ where: { userId: U14.id } }))?.lembreteRaspadaEm;
  conferir('ciclos seguintes não avisam de novo a mesma liberação', l2?.getTime() === l1?.getTime());

  const fora = { ini: horaSP(new Date(agoraL.getTime() + 2 * 3_600_000)), fim: horaSP(new Date(agoraL.getTime() + 3 * 3_600_000)) };
  await prisma.user.update({ where: { id: U13.id }, data: { expoPushToken: 'aceite-token-invalido' } });
  await prisma.sorteCarteira.update({ where: { userId: U13.id }, data: { lembreteRaspadaEm: null } });
  await salvarConfig({ lembreteInicio: fora.ini, lembreteFim: fora.fim });
  await esperar(7_000);
  const l3 = (await prisma.sorteCarteira.findUnique({ where: { userId: U13.id } }))?.lembreteRaspadaEm;
  conferir(`fora da janela (${fora.ini}–${fora.fim}): nenhum aviso`, l3 === null, String(l3));
  await prisma.user.updateMany({ where: { id: { in: [U13.id, U14.id] } }, data: { expoPushToken: null } });

  // ---------------------------------------------------------------- 1
  secao('1. Inscrição');
  await P('PUT', `/inscricoes/${U0.id}`, { inscrito: false, motivo: 'aceite' });
  const naoInscrito = await A(U0, 'POST', '/raspar');
  const lojaNegada = await A(U0, 'GET', '/loja');
  conferir(
    'sem inscrição: raspar e loja → 403 NAO_INSCRITO',
    naoInscrito.status === 403 && naoInscrito.dados?.code === 'NAO_INSCRITO' && lojaNegada.dados?.code === 'NAO_INSCRITO',
    JSON.stringify(naoInscrito.dados),
  );
  const resumoNao = await A(U0, 'GET', '/resumo');
  conferir('resumo continua respondendo (inscrito: false, sem raspadinha)', resumoNao.status === 200 && resumoNao.dados?.inscrito === false && resumoNao.dados?.raspadinha === null);
  const regulamento = await A(U0, 'GET', '/regulamento');
  conferir('regulamento não exige inscrição', regulamento.status === 200);
  await P('PUT', `/inscricoes/${U0.id}`, { inscrito: true, motivo: 'aceite' });
  conferir('marcada de novo à mão: raspa', (await A(U0, 'GET', '/resumo')).dados?.inscrito === true);
  const lista = await P('GET', `/inscricoes?busca=Aceite&limit=100`);
  const idsLista = (lista.dados?.data ?? []).map((i) => i.associado.id);
  conferir(
    'lista de participantes: um registro por associado (fonte MANUAL)',
    idsLista.length >= TOTAL_USUARIOS && new Set(idsLista).size === idsLista.length && lista.dados.data.every((i) => i.fonte === 'MANUAL'),
  );
  conferir('produto 3677 / INATIVO / dois veículos: coberto por sorte-inscricao.service.spec.ts (SGA)', true);

  // ---------------------------------------------------------------- 2
  secao('2. Base MAIS_PRIME_RS vê a promoção inativa');
  const rs = await chamar('POST', '/auth/login', { corpo: { cpf: '90000000201', password: SENHA } });
  const tokenRs = rs.dados?.access_token;
  const resumoRs = await chamar('GET', '/associado-sorte/resumo', { token: tokenRs });
  const rasparRs = await chamar('POST', '/associado-sorte/raspar', { token: tokenRs });
  conferir('resumo { ativa: false } e raspar 403 PROMOCAO_INATIVA', resumoRs.dados?.ativa === false && rasparRs.dados?.code === 'PROMOCAO_INATIVA', `${JSON.stringify(resumoRs.dados)} ${rasparRs.dados?.code}`);

  // ---------------------------------------------------------------- 10
  secao('10. Não inscrito recebe o convite do WhatsApp');
  const demo104 = await chamar('POST', '/auth/login', { corpo: { cpf: '90000000104', password: SENHA } });
  const convite = await chamar('GET', '/associado-sorte/resumo', { token: demo104.dados?.access_token });
  const cfgAtual = (await P('GET', `/config/${BASE}`)).dados;
  conferir(
    'resumo do não inscrito traz convite.link = wa.me/<whatsappConvite>?text=<mensagemConvite>',
    convite.dados?.inscrito === false &&
      convite.dados?.convite?.link ===
        `https://wa.me/${cfgAtual.whatsappConvite}?text=${encodeURIComponent(cfgAtual.mensagemConvite)}`,
    JSON.stringify(convite.dados?.convite),
  );

  // ---------------------------------------------------------------- 11
  secao('11. Extrato do associado no painel: raspadas e tentativas que falharam');
  await esperar(500);
  const raspadasPainel = await P('GET', `/associados/${U12.id}/raspadas`);
  conferir('histórico de raspadas', raspadasPainel.dados?.data?.length === 2, JSON.stringify(raspadasPainel.dados?.meta));
  const tentativas12 = await P('GET', `/associados/${U12.id}/tentativas`);
  const codigos12 = (tentativas12.dados?.data ?? []).map((t) => t.codigo);
  conferir(
    'tentativas INTERVALO e LIMITE_DIARIO ("Tentou raspar e não conseguiu: …")',
    codigos12.includes('INTERVALO') &&
      codigos12.includes('LIMITE_DIARIO') &&
      tentativas12.dados.data.every((t) => t.descricao.startsWith('Tentou raspar')),
    codigos12.join(','),
  );
  const tentativas0 = (await P('GET', `/associados/${U0.id}/tentativas?limit=50`)).dados?.data ?? [];
  conferir(
    'tentativas de compra (LIMITE_POR_ASSOCIADO, CREDITOS_INSUFICIENTES) e NAO_INSCRITO',
    ['LIMITE_POR_ASSOCIADO', 'CREDITOS_INSUFICIENTES', 'NAO_INSCRITO'].every((c) => tentativas0.some((t) => t.codigo === c)),
    tentativas0.map((t) => `${t.acao}:${t.codigo}`).join(','),
  );
  const associado = await P('GET', `/associados?busca=${U0.cpf}`);
  conferir('lista de associados traz a inscrição (fonte e data)', associado.dados?.data?.[0]?.inscricao?.fonte === 'MANUAL');
  const dash = await P('GET', `/dashboard?baseOrigin=${BASE}`);
  conferir(
    'visão geral com raspadas hoje, vouchers, créditos em circulação, retiradas e notificações',
    typeof dash.dados?.raspadasHoje === 'number' && dash.dados.raspadasHoje >= 15 &&
      typeof dash.dados.creditosEmCirculacao === 'number' &&
      typeof dash.dados.retiradasAguardandoContato === 'number' &&
      typeof dash.dados.notificacoesNaoLidas === 'number',
  );

  // ---------------------------------------------------------------- 12
  secao('12. rodadasHabilitadas = false → rotas de rodada do app em 404');
  const rodadasPainel = await P('GET', `/rodadas?baseOrigin=${BASE}&estado=PUBLICADA&limit=1`);
  const rodadaId = rodadasPainel.dados?.data?.[0]?.id ?? 1;
  const r404 = await Promise.all([
    A(U0, 'GET', `/rodadas/${rodadaId}`),
    A(U0, 'POST', `/rodadas/${rodadaId}/participar`, {}),
    A(U0, 'POST', `/rodadas/${rodadaId}/resgatar`),
    A(U0, 'POST', `/rodadas/${rodadaId}/lembrete`),
  ]);
  conferir('detalhe, participar, resgatar e avise-me → 404', r404.every((r) => r.status === 404), r404.map((r) => r.status).join(','));
  if (rodadasPainel.dados?.data?.[0]) {
    await salvarConfig({ rodadasHabilitadas: true });
    const ligada = await A(U0, 'GET', `/rodadas/${rodadaId}`);
    conferir('com a flag ligada a rota volta a responder', ligada.status === 200, String(ligada.status));
    await salvarConfig({ rodadasHabilitadas: false });
  }
  const resumoSemRodadas = await A(U0, 'GET', '/resumo');
  conferir('resumo sem rodadas com a flag desligada', resumoSemRodadas.dados?.rodadasHabilitadas === false && resumoSemRodadas.dados?.rodadas?.length === 0);

  // ------------------------------------------------------------ limpeza
  secao('Limpeza');
  await P('POST', `/campanhas/${campanha.id}/encerrar`, { motivo: 'Fim do roteiro de aceite' });
  for (const p of [pLimite, pUnico, pCaro]) {
    if (p?.id) await P('PATCH', `/premios/${p.id}`, { naLoja: false, ativo: false });
  }
  const minhas = (await P('GET', `/notificacoes?lida=false&limit=100`)).dados?.data ?? [];
  for (const n of minhas.filter((n) => /aceite/i.test(n.titulo))) {
    await P('POST', `/notificacoes/${n.id}/lida`);
  }
  const restaurar = {};
  for (const campo of [
    'ativa', 'raspadasPorDia', 'intervaloMinimoMinutos', 'carenciaDias', 'jornadaAtiva',
    'marcosSequencia', 'lembretesAtivos', 'lembreteInicio', 'lembreteFim', 'whatsappConvite',
    'mensagemConvite', 'emailNotificacoes', 'whatsappMarketing', 'rodadasHabilitadas',
  ]) {
    if (configOriginal?.[campo] !== undefined) restaurar[campo] = configOriginal[campo] ?? '';
  }
  const rest = await salvarConfig(restaurar);
  conferir('configuração original restaurada', rest.status === 200);
  if (process.env.SORTE_ACEITE_SEM_SEED !== '1') {
    execSync('npm run sorte:seed-demo', { stdio: 'ignore' });
    const nova = await P('GET', `/campanhas?baseOrigin=${BASE}&estado=PUBLICADA`);
    conferir('seed de demonstração reaplicado (campanha de demonstração publicada)', nova.dados?.data?.[0]?.nome === 'Campanha de demonstração');
  }
}

main()
  .catch((erro) => {
    falhas++;
    console.error('\nErro inesperado:', erro);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('\nPlacar por critério:');
    for (const [nome, r] of resultadoPorCriterio) {
      console.log(`  ${r.falhou ? '✖' : '✔'} ${nome}: ${r.ok}/${r.ok + r.falhou}`);
    }
    console.log(`\n${total - falhas}/${total} verificações OK${falhas ? ` — ${falhas} falha(s)` : ''}`);
    process.exitCode = falhas ? 1 : 0;
  });
