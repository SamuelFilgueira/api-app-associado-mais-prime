/**
 * Dados de DEMONSTRAÇÃO do Associado da Sorte (v2), para o marketing testar
 * o painel e o app rapidamente. NÃO é seed de produção: recusa
 * `NODE_ENV=production`.
 *
 * O que cria/ajusta (idempotente — rodar de novo não duplica):
 *   1. configuração da MAIS_PRIME pronta para teste rápido: 3 raspadas por
 *      dia, intervalo de 1 min, carência 0, jornada ligada com marcos,
 *      lembretes ativos, WhatsApp fictícios (convite e marketing) e
 *      e-mail marketing@teste.com.br (as demais bases: promoção ativa, como no piloto);
 *   2. usuário do painel com perfil MARKETING;
 *   3. associados fictícios por base; na MAIS_PRIME, 90000000101–103
 *      inscritos e 104–106 não inscritos (marcação MANUAL: o backend não
 *      consulta o SGA para eles);
 *   4. Loja da Sorte com 5 produtos dos 3 tipos (um com estoque 1);
 *   5. "Campanha de demonstração" PUBLICADA: 3 momentos já liberados (o
 *      primeiro a raspar ganha na hora) e um a cada 2 min pelas próximas
 *      ~3 h, de 120/150/200 créditos. Rodar de novo reaproveita a campanha
 *      enquanto ela tiver momentos para mais de 1 h; senão, encerra a antiga
 *      e publica outra;
 *   6. uma segunda campanha em RASCUNHO para testar a importação do CSV
 *      (exemplo em docs/exemplos/cronograma-exemplo.csv).
 *
 * Rodadas do piloto (sorteio/corrida/vitrine) que já existirem ficam como
 * estão; para criar as de demonstração do piloto: SORTE_DEMO_RODADAS=1.
 *
 * Uso:
 *   npm run sorte:seed-demo
 *
 * Variáveis opcionais:
 *   SORTE_DEMO_SENHA             senha dos usuários de demonstração (padrão Demo@1234)
 *   SORTE_DEMO_RODADAS=1         também cria as rodadas de demonstração do piloto
 *   SORTE_DEMO_CORRIDA_MINUTOS   em quantos minutos a corrida do piloto abre (padrão 3)
 */
import {
  PrismaClient,
  SorteCampanhaEstado,
  SorteEstoqueMovimentoTipo,
  SorteFonteCredito,
  SorteGanhadorSituacao,
  SorteMecanica,
  SorteModoCredito,
  SorteRodadaEstado,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { hashCronograma } from '../src/associado-sorte/helpers/sorte-cronograma.helper';
import { TENANT } from '../src/config/tenant.config';

const prisma = new PrismaClient();

const SENHA = process.env.SORTE_DEMO_SENHA || 'Demo@1234';
const CORRIDA_MINUTOS = Math.max(
  1,
  Number(process.env.SORTE_DEMO_CORRIDA_MINUTOS) || 3,
);
const EMAIL_MARKETING = 'marketing.demo@maisprime.local';
const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

const REGULAMENTO_DEMO = `REGULAMENTO DE DEMONSTRAÇÃO — ASSOCIADO DA SORTE

1. Participam os associados da Mais Prime inscritos no produto "Associado da Sorte".
2. Todos os dias o associado pode raspar a raspadinha no aplicativo e descobrir se ganhou um voucher em créditos (1 crédito = R$ 1).
3. Há um voucher por dia, num horário sorteado com antecedência, não divulgado, registrado e travado antes do início da campanha. Ganha o primeiro associado apto que raspar no horário ou depois dele; se ninguém raspar no dia, o voucher continua valendo para a próxima raspada.
4. O prêmio é sempre um voucher em créditos (vale-brinde, sem conversão em dinheiro), que vale para qualquer produto da Loja da Sorte, inclusive os que entrarem depois.
5. Os créditos não expiram e são usados na Loja da Sorte.
6. Depois da compra, a equipe chama o associado no WhatsApp para combinar a retirada, conferindo o código do pedido.

Este texto é um exemplo. Substitua pelo regulamento oficial no painel.`;

/** Base da v2 (SORTE_BASES_CONTEMPLADAS). */
const BASE_V2 = 'MAIS_PRIME';
const NOME_CAMPANHA = 'Campanha de demonstração';
const NOME_RASCUNHO = 'Campanha rascunho (importar CSV)';
const AUTOR_SEED = 'Seed de demonstração';

/** Produtos da Loja da Sorte (nome é a chave de idempotência). */
const PRODUTOS_LOJA = [
  {
    chave: 'loja-furadeira',
    nome: 'Furadeira de impacto',
    descricao: 'Furadeira de impacto 650 W com maleta. Demonstração.',
    tipo: 'FISICO' as const,
    custoCreditos: 120,
    estoque: 5,
    limitePorAssociado: 1,
    instrucoesRetirada:
      'Retire na sede da Mais Prime apresentando o código do pedido e um documento com foto.',
    cores: ['#3A6EA5', '#1B3550'],
  },
  {
    chave: 'loja-plano-dental',
    nome: 'Plano dental 1 mês',
    descricao: 'Um mês de plano odontológico Mais Prime. Demonstração.',
    tipo: 'SERVICO_MAIS_PRIME' as const,
    custoCreditos: 89,
    estoque: 50,
    limitePorAssociado: 1,
    instrucoesRetirada:
      'A equipe ativa o plano no seu cadastro em até 2 dias úteis e confirma pelo WhatsApp.',
    cores: ['#2BA5A5', '#0F4F4F'],
  },
  {
    chave: 'loja-reboque',
    nome: 'Reboque 2.000 km por 1 mês',
    descricao: 'Cobertura de reboque de até 2.000 km por 30 dias. Demonstração.',
    tipo: 'SERVICO_MAIS_PRIME' as const,
    custoCreditos: 150,
    estoque: 30,
    limitePorAssociado: 0,
    instrucoesRetirada:
      'A equipe ativa a cobertura no seu veículo e envia a confirmação pelo WhatsApp.',
    cores: ['#D9251C', '#7A130E'],
  },
  {
    chave: 'loja-cupom-page',
    nome: 'Cupom 20% Pagé Amortecedores',
    descricao: '20% de desconto em amortecedores na Pagé. Demonstração.',
    tipo: 'CUPOM_PARCEIRO' as const,
    custoCreditos: 60,
    estoque: 100,
    limitePorAssociado: 2,
    instrucoesRetirada:
      'Apresente este cupom (código do pedido) na Pagé Amortecedores.',
    cores: ['#F2A900', '#7A5500'],
  },
  {
    chave: 'loja-garrafa',
    nome: 'Garrafa térmica (última unidade)',
    descricao: 'Garrafa térmica 1 L. Só 1 unidade: para testar o esgotado.',
    tipo: 'FISICO' as const,
    custoCreditos: 40,
    estoque: 1,
    limitePorAssociado: 0,
    instrucoesRetirada:
      'Retire na sede da Mais Prime apresentando o código do pedido.',
    cores: ['#B7791F', '#5F3F0F'],
  },
];

/** Valores dos vouchers, em rodízio. */
const VALORES_VOUCHER = [120, 150, 200];

const PREMIOS = [
  {
    chave: 'kit-churrasco',
    nome: 'Kit Churrasco Mais Prime',
    descricao:
      'Tábua de corte, faca, garfo trinchante e avental. Demonstração.',
    valorEstimado: 189.9,
    estoque: 6,
    cores: ['#D9251C', '#7A130E'],
  },
  {
    chave: 'caixa-de-som',
    nome: 'Caixa de Som Bluetooth',
    descricao: 'Caixa de som portátil à prova de respingos. Demonstração.',
    valorEstimado: 249,
    estoque: 4,
    cores: ['#141414', '#4A4A4A'],
  },
  {
    chave: 'vale-combustivel',
    nome: 'Vale-combustível R$ 100',
    descricao:
      'Crédito de R$ 100 para abastecer na rede parceira. Demonstração.',
    valorEstimado: 100,
    estoque: 12,
    cores: ['#1F7A4D', '#0E3D27'],
  },
  {
    chave: 'garrafa-termica',
    nome: 'Garrafa Térmica 1L',
    descricao: 'Mantém gelado por 24h. Demonstração.',
    valorEstimado: 79.9,
    estoque: 10,
    cores: ['#B7791F', '#5F3F0F'],
  },
] as const;

const NOMES = [
  'Ana Beatriz Demo Souza',
  'Bruno Demo Carvalho',
  'Carla Demo Menezes',
  'Diego Demo Ferreira',
  'Elaine Demo Rocha',
  'Fábio Demo Lima',
];

function log(mensagem: string) {
  console.log(`[sorte-demo] ${mensagem}`);
}

/** Código curto no mesmo alfabeto do serviço (sem 0/O, 1/I/L). */
function codigoDemo(): string {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let codigo = '';
  for (let i = 0; i < 6; i++) {
    codigo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  }
  return codigo;
}

async function gerarImagem(
  chave: string,
  nome: string,
  cores: readonly [string, string] | readonly string[],
): Promise<string> {
  const pasta = join(process.cwd(), 'uploads', 'associado-sorte');
  await fs.mkdir(pasta, { recursive: true });
  const arquivo = `demo-${chave}.webp`;
  const linhas = nome.split(' ');
  const meio = Math.ceil(linhas.length / 2);
  const linha1 = linhas.slice(0, meio).join(' ');
  const linha2 = linhas.slice(meio).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${cores[0]}"/><stop offset="1" stop-color="${cores[1]}"/>
    </linearGradient></defs>
    <rect width="800" height="800" fill="url(#g)"/>
    <circle cx="400" cy="300" r="150" fill="#ffffff" fill-opacity="0.14"/>
    <circle cx="400" cy="300" r="96" fill="#ffffff" fill-opacity="0.2"/>
    <text x="400" y="560" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="700" fill="#ffffff" text-anchor="middle">${linha1}</text>
    <text x="400" y="630" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="700" fill="#ffffff" text-anchor="middle">${linha2}</text>
    <text x="400" y="720" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#ffffff" fill-opacity="0.75" text-anchor="middle">imagem de demonstração</text>
  </svg>`;
  await sharp(Buffer.from(svg))
    .webp({ quality: 85 })
    .toFile(join(pasta, arquivo));
  return `/uploads/associado-sorte/${arquivo}`;
}

async function seedConfig(bases: string[]) {
  for (const baseOrigin of bases) {
    const existente = await prisma.sorteConfig.findUnique({
      where: { baseOrigin },
    });
    // Troca o regulamento só se ainda for o texto de demonstração.
    const regulamentoDemo =
      baseOrigin === BASE_V2 &&
      (!existente?.regulamento ||
        existente.regulamento.startsWith('REGULAMENTO DE DEMONSTRAÇÃO')) &&
      existente?.regulamento !== REGULAMENTO_DEMO
        ? { regulamento: REGULAMENTO_DEMO, regulamentoAtualizadoEm: new Date() }
        : {};
    const v2 =
      baseOrigin === BASE_V2
        ? {
            ativa: true,
            subtitulo: 'Raspe todo dia e troque seus créditos na Loja da Sorte',
            raspadasPorDia: 3,
            intervaloMinimoMinutos: 1,
            carenciaDias: 0,
            jornadaAtiva: true,
            marcosSequencia: [
              { dias: 3, bonus: 20 },
              { dias: 7, bonus: 50 },
            ],
            lembretesAtivos: true,
            lembreteInicio: '08:00',
            lembreteFim: '21:00',
            whatsappConvite: '5500000000000',
            mensagemConvite:
              'Olá, sou associado da Mais Prime e gostaria de saber sobre a promoção do associado da sorte',
            emailNotificacoes: 'marketing@teste.com.br',
            whatsappMarketing: '5500000000099',
            rodadasHabilitadas: false,
            produtoSgaCodigo: '3677',
            produtoSgaDescricao: 'ASSOCIADO DA SORTE',
            inscricaoValidadeHoras: 6,
          }
        : { ativa: true };
    await prisma.sorteConfig.upsert({
      where: { baseOrigin },
      update: { ...v2, ...regulamentoDemo },
      create: {
        baseOrigin,
        titulo: 'Associado da Sorte',
        subtitulo: 'Raspe todo dia e troque seus créditos na Loja da Sorte',
        regulamento: REGULAMENTO_DEMO,
        regulamentoAtualizadoEm: new Date(),
        whatsappSuporte: '5521999990000',
        fonteCreditoDiario: SorteFonteCredito.RASPADINHA,
        faixasRaspadinha: [
          { creditos: 1, peso: 60 },
          { creditos: 3, peso: 30 },
          { creditos: 10, peso: 10 },
        ],
        creditosCheckin: 2,
        marcosSequencia: [
          { dias: 3, bonus: 20 },
          { dias: 7, bonus: 50 },
        ],
        exibirGanhadores: true,
        ...v2,
      },
    });
    log(
      baseOrigin === BASE_V2
        ? `configuração de demonstração em ${baseOrigin}: 3 raspadas/dia, intervalo 1 min, jornada ligada, lembretes 08:00–21:00`
        : `promoção ativa em ${baseOrigin} (fora das bases contempladas: o app mostra inativa)`,
    );
  }
}

async function seedMarketing() {
  const existente = await prisma.adminPanelUser.findUnique({
    where: { email: EMAIL_MARKETING },
  });
  if (existente) {
    log(`usuário do painel já existe: ${EMAIL_MARKETING}`);
    return;
  }
  await prisma.adminPanelUser.create({
    data: {
      name: 'Marketing (demo)',
      email: EMAIL_MARKETING,
      password: await bcrypt.hash(SENHA, 10),
      role: 'MARKETING',
    },
  });
  log(`usuário MARKETING do painel criado: ${EMAIL_MARKETING} / ${SENHA}`);
}

/** Associados fictícios: CPFs 9000000BBNN não pertencem a ninguém. */
async function seedAssociados(bases: string[]): Promise<Map<string, number[]>> {
  const porBase = new Map<string, number[]>();
  const passwordHash = await bcrypt.hash(SENHA, 10);

  for (const [indiceBase, baseOrigin] of bases.entries()) {
    const ids: number[] = [];
    for (const [indice, nome] of NOMES.entries()) {
      const cpf = `9000000${String(indiceBase + 1).padStart(2, '0')}${String(indice + 1).padStart(2, '0')}`;
      const usuario = await prisma.user.upsert({
        where: { cpf },
        update: {},
        create: {
          name: nome,
          cpf,
          email: `demo${indiceBase + 1}${indice + 1}@maisprime.local`,
          passwordHash,
          baseOrigin,
          isActive: true,
          primeiroLogin: false,
        },
      });
      ids.push(usuario.id);

      // Créditos de demonstração só na primeira vez (carteira ainda não existe).
      const carteira = await prisma.sorteCarteira.findUnique({
        where: { userId: usuario.id },
      });
      if (!carteira) {
        const saldo = 40;
        await prisma.$transaction([
          prisma.sorteCarteira.create({
            data: { userId: usuario.id, baseOrigin, saldo, totalGanho: saldo },
          }),
          prisma.sorteCreditoLancamento.create({
            data: {
              userId: usuario.id,
              baseOrigin,
              tipo: 'AJUSTE_ADMIN',
              valor: saldo,
              saldoApos: saldo,
              descricao: 'Créditos de demonstração',
              autorNome: 'Seed de demonstração',
            },
          }),
        ]);
      }
    }
    porBase.set(baseOrigin, ids);
    log(
      `${ids.length} associados de demonstração em ${baseOrigin} (CPF 9000000${String(indiceBase + 1).padStart(2, '0')}01… / senha ${SENHA})`,
    );
  }
  return porBase;
}

/**
 * Inscrições da MAIS_PRIME: 101–103 inscritos, 104–106 não inscritos. Fonte
 * MANUAL: prevalece e o backend não chama o SGA para esses CPFs fictícios.
 * Inscritos ficam com pelo menos 300 créditos para testar a loja na hora.
 */
async function seedInscricoes(associados: Map<string, number[]>) {
  const ids = associados.get(BASE_V2) ?? [];
  for (const [indice, userId] of ids.entries()) {
    const inscrito = indice < 3;
    await prisma.sorteInscricao.upsert({
      where: { userId },
      update: {
        inscrito,
        fonte: 'MANUAL',
        baseOrigin: BASE_V2,
        autorNome: AUTOR_SEED,
        motivo: 'Associado de demonstração',
        verificadoEm: new Date(),
      },
      create: {
        userId,
        inscrito,
        fonte: 'MANUAL',
        baseOrigin: BASE_V2,
        autorNome: AUTOR_SEED,
        motivo: 'Associado de demonstração',
        verificadoEm: new Date(),
      },
    });
    if (!inscrito) continue;
    const carteira = await prisma.sorteCarteira.findUnique({
      where: { userId },
    });
    const minimo = 300;
    if (carteira && carteira.saldo < minimo) {
      const valor = minimo - carteira.saldo;
      await prisma.$transaction([
        prisma.sorteCarteira.update({
          where: { userId },
          data: { saldo: minimo, totalGanho: carteira.totalGanho + valor },
        }),
        prisma.sorteCreditoLancamento.create({
          data: {
            userId,
            baseOrigin: BASE_V2,
            tipo: 'AJUSTE_ADMIN',
            valor,
            saldoApos: minimo,
            descricao: 'Créditos de demonstração (loja)',
            autorNome: AUTOR_SEED,
          },
        }),
      ]);
    }
  }
  log(
    `inscrições em ${BASE_V2}: CPF 90000000101–103 inscritos (saldo ≥ 300), 104–106 não inscritos (MANUAL)`,
  );
}

/** Loja da Sorte: cria ou ajusta os produtos e repõe o estoque de demonstração. */
async function seedLoja() {
  for (const [ordem, p] of PRODUTOS_LOJA.entries()) {
    let produto = await prisma.sortePremio.findFirst({
      where: { nome: p.nome, deletedAt: null },
    });
    const dados = {
      descricao: p.descricao,
      tipo: p.tipo,
      custoCreditos: p.custoCreditos,
      naLoja: true,
      ativo: true,
      limitePorAssociado: p.limitePorAssociado,
      instrucoesRetirada: p.instrucoesRetirada,
      ordem: ordem + 1,
      valorEstimado: p.custoCreditos,
    };
    if (!produto) {
      const imagemUrl = await gerarImagem(p.chave, p.nome, p.cores);
      produto = await prisma.sortePremio.create({
        data: {
          nome: p.nome,
          ...dados,
          imagemUrl,
          estoque: p.estoque,
          movimentos: {
            create: {
              tipo: SorteEstoqueMovimentoTipo.ENTRADA,
              quantidade: p.estoque,
              estoqueApos: p.estoque,
              motivo: 'Estoque inicial (demonstração)',
              autorNome: AUTOR_SEED,
            },
          },
        },
      });
      log(`produto da loja criado: ${p.nome} (${p.custoCreditos} créditos, estoque ${p.estoque})`);
      continue;
    }
    await prisma.sortePremio.update({ where: { id: produto.id }, data: dados });
    if (produto.estoque < p.estoque) {
      const entrada = p.estoque - produto.estoque;
      await prisma.$transaction([
        prisma.sortePremio.update({
          where: { id: produto.id },
          data: { estoque: p.estoque },
        }),
        prisma.sorteEstoqueMovimento.create({
          data: {
            premioId: produto.id,
            tipo: SorteEstoqueMovimentoTipo.ENTRADA,
            quantidade: entrada,
            estoqueApos: p.estoque,
            motivo: 'Reposição (demonstração)',
            autorNome: AUTOR_SEED,
          },
        }),
      ]);
      log(`estoque reposto: ${p.nome} (${produto.estoque} → ${p.estoque})`);
    } else {
      log(`produto da loja já existe: ${p.nome}`);
    }
  }
}

/** Cronograma de demonstração a partir de `agora`. */
function momentosDemo(agora: Date) {
  const momentos: { liberaEm: Date; creditos: number; descricao: string }[] = [];
  // Já liberados: o primeiro a raspar ganha na hora.
  for (const [i, minutos] of [30, 20, 10].entries()) {
    momentos.push({
      liberaEm: new Date(agora.getTime() - minutos * MINUTO),
      creditos: VALORES_VOUCHER[i % VALORES_VOUCHER.length],
      descricao: `Voucher liberado (demo ${i + 1})`,
    });
  }
  // Depois, um a cada 2 minutos pelas próximas 3 horas.
  const inicio = Math.ceil(agora.getTime() / MINUTO) * MINUTO;
  for (let i = 1; i <= 90; i++) {
    momentos.push({
      liberaEm: new Date(inicio + i * 2 * MINUTO),
      creditos: VALORES_VOUCHER[(i + 2) % VALORES_VOUCHER.length],
      descricao: `Voucher das ${new Date(inicio + i * 2 * MINUTO).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`,
    });
  }
  return momentos;
}

/**
 * Campanha publicada da MAIS_PRIME. Reaproveita a de demonstração enquanto
 * ela tiver momentos para mais de 1 h; senão (ou se houver outra publicada),
 * encerra e publica uma nova, com o hash do cronograma como o painel faria.
 */
async function seedCampanhas() {
  const agora = new Date();
  const publicadas = await prisma.sorteCampanha.findMany({
    where: { baseOrigin: BASE_V2, estado: SorteCampanhaEstado.PUBLICADA },
  });
  for (const c of publicadas) {
    const futuros = await prisma.sorteMomentoPremiado.count({
      where: {
        campanhaId: c.id,
        userId: null,
        liberaEm: { gt: new Date(agora.getTime() + HORA) },
      },
    });
    if (c.nome === NOME_CAMPANHA && futuros > 0 && c.fim > agora) {
      log(`campanha publicada reaproveitada: ${c.nome} (#${c.id}, ${futuros} momento(s) depois de 1 h)`);
      await seedRascunho(agora);
      return;
    }
    await prisma.sorteCampanha.update({
      where: { id: c.id },
      data: {
        estado: SorteCampanhaEstado.ENCERRADA,
        encerradaEm: agora,
        encerradaPorNome: AUTOR_SEED,
        motivoEncerramento: 'Substituída pela nova campanha de demonstração',
      },
    });
    log(`campanha #${c.id} "${c.nome}" encerrada (substituída)`);
  }

  const campanha = await prisma.sorteCampanha.create({
    data: {
      baseOrigin: BASE_V2,
      nome: NOME_CAMPANHA,
      inicio: new Date(agora.getTime() - DIA),
      fim: new Date(agora.getTime() + 30 * DIA),
    },
  });
  await prisma.sorteMomentoPremiado.createMany({
    data: momentosDemo(agora).map((m) => ({ ...m, campanhaId: campanha.id })),
  });
  const momentos = await prisma.sorteMomentoPremiado.findMany({
    where: { campanhaId: campanha.id },
    select: { id: true, liberaEm: true, creditos: true, descricao: true },
  });
  const hash = hashCronograma(campanha, momentos);
  await prisma.sorteCampanha.update({
    where: { id: campanha.id },
    data: {
      estado: SorteCampanhaEstado.PUBLICADA,
      publicadaEm: agora,
      publicadaPorNome: AUTOR_SEED,
      hashCronograma: hash,
    },
  });
  log(
    `campanha PUBLICADA: ${NOME_CAMPANHA} (#${campanha.id}): 3 momentos já liberados + 90 (um a cada 2 min por 3 h), sha256 ${hash.slice(0, 12)}…`,
  );
  await seedRascunho(agora);
}

async function seedRascunho(agora: Date) {
  const existente = await prisma.sorteCampanha.findFirst({
    where: { nome: NOME_RASCUNHO, estado: SorteCampanhaEstado.RASCUNHO },
  });
  if (existente) {
    log(`campanha em rascunho já existe: ${NOME_RASCUNHO} (#${existente.id})`);
    return;
  }
  const inicio = new Date(agora.getTime() + DIA);
  const r = await prisma.sorteCampanha.create({
    data: {
      baseOrigin: BASE_V2,
      nome: NOME_RASCUNHO,
      // 14/11/2026 00:00 → 31/01/2027 23:59 (Brasília) cobre o CSV de exemplo.
      inicio: new Date(Math.min(inicio.getTime(), Date.parse('2026-11-14T03:00:00.000Z'))),
      fim: new Date(Math.max(agora.getTime() + 60 * DIA, Date.parse('2027-02-01T02:59:00.000Z'))),
    },
  });
  log(`campanha em RASCUNHO criada: ${NOME_RASCUNHO} (#${r.id}) — importe docs/exemplos/cronograma-exemplo.csv`);
}

async function seedPremios(): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const p of PREMIOS) {
    let premio = await prisma.sortePremio.findFirst({
      where: { nome: p.nome, deletedAt: null },
    });
    if (!premio) {
      const imagemUrl = await gerarImagem(p.chave, p.nome, p.cores);
      premio = await prisma.sortePremio.create({
        data: {
          nome: p.nome,
          descricao: p.descricao,
          valorEstimado: p.valorEstimado,
          imagemUrl,
          estoque: p.estoque,
          movimentos: {
            create: {
              tipo: SorteEstoqueMovimentoTipo.ENTRADA,
              quantidade: p.estoque,
              estoqueApos: p.estoque,
              motivo: 'Estoque inicial (demonstração)',
              autorNome: 'Seed de demonstração',
            },
          },
        },
      });
      log(`prêmio criado: ${p.nome} (estoque ${p.estoque})`);
    }
    ids.set(p.chave, premio.id);
  }
  return ids;
}

/** Garante estoque livre para publicar mais `quantidade` unidades do prêmio. */
async function garantirEstoque(premioId: number, quantidade: number) {
  const premio = await prisma.sortePremio.findUniqueOrThrow({
    where: { id: premioId },
  });
  const reservado = await prisma.sorteRodada.aggregate({
    where: {
      premioId,
      estado: { in: [SorteRodadaEstado.PUBLICADA, SorteRodadaEstado.APURANDO] },
    },
    _sum: { quantidadeRestante: true },
  });
  const livre = premio.estoque - (reservado._sum.quantidadeRestante ?? 0);
  if (livre >= quantidade) return;

  const entrada = quantidade - livre;
  const estoqueApos = premio.estoque + entrada;
  await prisma.$transaction([
    prisma.sortePremio.update({
      where: { id: premioId },
      data: { estoque: estoqueApos },
    }),
    prisma.sorteEstoqueMovimento.create({
      data: {
        premioId,
        tipo: SorteEstoqueMovimentoTipo.ENTRADA,
        quantidade: entrada,
        estoqueApos,
        motivo: 'Reposição (demonstração)',
        autorNome: 'Seed de demonstração',
      },
    }),
  ]);
}

interface RodadaDemo {
  titulo: string;
  premioId: number;
  mecanica: SorteMecanica;
  quantidade: number;
  custoCreditos: number;
  modoCredito: SorteModoCredito;
  bilhetesMaximos: number;
  abertura: Date;
  encerramento: Date;
}

/** Cria a rodada publicada se não houver outra "viva" com o mesmo título. */
async function publicarSeNaoHouver(
  rodada: RodadaDemo,
  bases: string[],
  viva: (agora: Date) => object,
) {
  const agora = new Date();
  const existente = await prisma.sorteRodada.findFirst({
    where: {
      titulo: rodada.titulo,
      estado: SorteRodadaEstado.PUBLICADA,
      ...viva(agora),
    },
  });
  if (existente) {
    log(`rodada já existe: ${rodada.titulo} (#${existente.id})`);
    return existente.id;
  }
  await garantirEstoque(rodada.premioId, rodada.quantidade);
  const criada = await prisma.sorteRodada.create({
    data: {
      ...rodada,
      quantidadeRestante: rodada.quantidade,
      estado: SorteRodadaEstado.PUBLICADA,
      bases: { create: bases.map((baseOrigin) => ({ baseOrigin })) },
    },
  });
  log(`rodada publicada: ${rodada.titulo} (#${criada.id})`);
  return criada.id;
}

async function seedRodadas(
  bases: string[],
  premios: Map<string, number>,
  associados: Map<string, number[]>,
) {
  const agora = new Date();

  // 1. Corrida abrindo em poucos minutos.
  await publicarSeNaoHouver(
    {
      titulo: 'Corrida relâmpago (demo)',
      premioId: premios.get('caixa-de-som')!,
      mecanica: SorteMecanica.CORRIDA,
      quantidade: 2,
      custoCreditos: 5,
      modoCredito: SorteModoCredito.SALDO_MINIMO,
      bilhetesMaximos: 1,
      abertura: new Date(agora.getTime() + CORRIDA_MINUTOS * MINUTO),
      encerramento: new Date(agora.getTime() + CORRIDA_MINUTOS * MINUTO + HORA),
    },
    bases,
    (quando) => ({ abertura: { gt: quando } }),
  );

  // 2. Sorteio aberto.
  await publicarSeNaoHouver(
    {
      titulo: 'Sorteio da semana (demo)',
      premioId: premios.get('kit-churrasco')!,
      mecanica: SorteMecanica.SORTEIO,
      quantidade: 2,
      custoCreditos: 3,
      modoCredito: SorteModoCredito.CONSOME,
      bilhetesMaximos: 5,
      abertura: new Date(agora.getTime() - HORA),
      encerramento: new Date(agora.getTime() + 2 * DIA),
    },
    bases,
    (quando) => ({ encerramento: { gt: quando } }),
  );

  // 3. Vitrine aberta.
  await publicarSeNaoHouver(
    {
      titulo: 'Vitrine de créditos (demo)',
      premioId: premios.get('garrafa-termica')!,
      mecanica: SorteMecanica.RESGATE,
      quantidade: 5,
      custoCreditos: 25,
      modoCredito: SorteModoCredito.CONSOME,
      bilhetesMaximos: 1,
      abertura: new Date(agora.getTime() - DIA),
      encerramento: new Date(agora.getTime() + 30 * DIA),
    },
    bases,
    (quando) => ({ encerramento: { gt: quando } }),
  );

  // 4. Sorteio encerrado com ganhador (histórico).
  const tituloEncerrado = 'Sorteio de estreia (demo)';
  const jaExiste = await prisma.sorteRodada.findFirst({
    where: { titulo: tituloEncerrado },
  });
  if (jaExiste) {
    log(`rodada já existe: ${tituloEncerrado} (#${jaExiste.id})`);
    return;
  }

  const premioId = premios.get('vale-combustivel')!;
  const inscritos = bases.flatMap((baseOrigin) =>
    (associados.get(baseOrigin) ?? [])
      .slice(0, 3)
      .map((userId) => ({ userId, baseOrigin })),
  );
  if (inscritos.length === 0) return;
  const ganhador = inscritos[0];
  const custo = 2;
  const abertura = new Date(agora.getTime() - 3 * DIA);
  const encerramento = new Date(agora.getTime() - DIA);

  await prisma.$transaction(async (tx) => {
    const premio = await tx.sortePremio.findUniqueOrThrow({
      where: { id: premioId },
    });
    const rodada = await tx.sorteRodada.create({
      data: {
        titulo: tituloEncerrado,
        premioId,
        mecanica: SorteMecanica.SORTEIO,
        quantidade: 1,
        quantidadeRestante: 0,
        custoCreditos: custo,
        modoCredito: SorteModoCredito.CONSOME,
        bilhetesMaximos: 3,
        abertura,
        encerramento,
        estado: SorteRodadaEstado.ENCERRADA,
        apuradaEm: encerramento,
        resumoApuracao: {
          apuradaEm: encerramento.toISOString(),
          origem: 'JOB',
          totalInscritos: inscritos.length,
          totalBilhetes: inscritos.length,
          elegiveis: inscritos.length,
          bilhetesElegiveis: inscritos.length,
          puladosPorCarencia: 0,
          puladosPorInatividade: 0,
          unidades: 1,
          estoqueNaApuracao: premio.estoque,
          limitadoPeloEstoque: false,
          ganhadores: 1,
        },
        bases: { create: bases.map((baseOrigin) => ({ baseOrigin })) },
      },
    });

    for (const inscrito of inscritos) {
      const carteira = await tx.sorteCarteira.findUniqueOrThrow({
        where: { userId: inscrito.userId },
      });
      const saldoApos = Math.max(0, carteira.saldo - custo);
      await tx.sorteCarteira.update({
        where: { userId: inscrito.userId },
        data: { saldo: saldoApos },
      });
      await tx.sorteCreditoLancamento.create({
        data: {
          userId: inscrito.userId,
          baseOrigin: inscrito.baseOrigin,
          tipo: 'PARTICIPACAO_SORTEIO',
          valor: -(carteira.saldo - saldoApos),
          saldoApos,
          rodadaId: rodada.id,
          descricao: '1 bilhete(s) no sorteio',
          createdAt: new Date(abertura.getTime() + HORA),
        },
      });
      await tx.sorteParticipacao.create({
        data: {
          rodadaId: rodada.id,
          userId: inscrito.userId,
          baseOrigin: inscrito.baseOrigin,
          bilhetes: 1,
          creditosGastos: custo,
          createdAt: new Date(abertura.getTime() + HORA),
        },
      });
    }

    const registro = await tx.sorteGanhador.create({
      data: {
        rodadaId: rodada.id,
        premioId,
        userId: ganhador.userId,
        baseOrigin: ganhador.baseOrigin,
        codigo: codigoDemo(),
        origem: SorteMecanica.SORTEIO,
        situacao: SorteGanhadorSituacao.AGUARDANDO_CONTATO,
        creditosGastos: custo,
        createdAt: encerramento,
      },
    });
    const estoqueApos = premio.estoque - 1;
    await tx.sortePremio.update({
      where: { id: premioId },
      data: { estoque: estoqueApos },
    });
    await tx.sorteEstoqueMovimento.create({
      data: {
        premioId,
        tipo: SorteEstoqueMovimentoTipo.SAIDA_GANHADOR,
        quantidade: -1,
        estoqueApos,
        motivo: `Ganhador ${registro.codigo} (rodada #${rodada.id})`,
        rodadaId: rodada.id,
        ganhadorId: registro.id,
        createdAt: encerramento,
      },
    });
    log(
      `rodada encerrada com ganhador: ${tituloEncerrado} (#${rodada.id}, código ${registro.codigo})`,
    );
  });
}

async function main() {
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new Error(
      'Seed de demonstração do Associado da Sorte não roda com NODE_ENV=production.',
    );
  }

  const bases = TENANT.baseNames;
  log(`bases: ${bases.join(', ')}`);

  await seedConfig(bases);
  await seedMarketing();
  const associados = await seedAssociados(bases);
  await seedInscricoes(associados);
  await seedLoja();
  await seedCampanhas();
  if (process.env.SORTE_DEMO_RODADAS === '1') {
    const premios = await seedPremios();
    await seedRodadas(bases, premios, associados);
  }

  log('concluído.');
}

main()
  .catch((erro) => {
    console.error(
      '[sorte-demo] falhou:',
      erro instanceof Error ? erro.message : erro,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
