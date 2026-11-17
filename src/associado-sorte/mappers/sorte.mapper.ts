import {
  SorteCampanha,
  SorteColetaDiaria,
  SorteConfig,
  SorteCreditoLancamento,
  SorteEstoqueMovimento,
  SorteInscricao,
  SorteNotificacaoAdmin,
  SortePremio,
  SorteRaspada,
  SorteTentativa,
} from '@prisma/client';
import {
  SORTE_ERRO_LABELS,
  SORTE_LANCAMENTO_LABELS,
  SORTE_TENTATIVA_ACAO_LABELS,
  SorteFaixaRaspadinha,
  SorteFase,
  SorteMarcoSequencia,
  SorteMecanica,
  SorteMomentoStatus,
  SorteRodadaEstado,
} from 'src/associado-sorte/enums/associado-sorte.enums';
import {
  calcularFase,
  lerFaixas,
  lerMarcos,
  linkWhatsapp,
  mascararCpf,
  nomePublico,
} from 'src/associado-sorte/helpers/sorte.helpers';
import {
  ContagemMomentos,
  MomentoComGanhador,
} from 'src/associado-sorte/repositories/sorte-campanhas.repository';
import { AssociadoComCarteira } from 'src/associado-sorte/repositories/sorte-creditos.repository';
import { GanhadorRecord } from 'src/associado-sorte/repositories/sorte-ganhadores.repository';
import {
  ParticipanteRecord,
  RodadaAdminRecord,
  RodadaAppRecord,
} from 'src/associado-sorte/repositories/sorte-rodadas.repository';

// ------------------------------------------------------------------ config

/** Configuração da base já com defaults e JSON validado. */
export interface SorteConfigView {
  baseOrigin: string;
  ativa: boolean;
  titulo: string;
  subtitulo: string | null;
  regulamento: string | null;
  regulamentoAtualizadoEm: Date | null;
  whatsappSuporte: string | null;
  fonteCreditoDiario: 'RASPADINHA' | 'CHECKIN' | 'NENHUMA';
  faixasRaspadinha: SorteFaixaRaspadinha[];
  creditosCheckin: number;
  marcosSequencia: SorteMarcoSequencia[];
  exibirGanhadores: boolean;
  carenciaDias: number;
  // ---- v2 ----
  produtoSgaCodigo: string;
  produtoSgaDescricao: string;
  inscricaoValidadeHoras: number;
  raspadasPorDia: number;
  intervaloMinimoMinutos: number;
  jornadaAtiva: boolean;
  lembretesAtivos: boolean;
  lembreteInicio: string;
  lembreteFim: string;
  whatsappConvite: string | null;
  mensagemConvite: string;
  emailNotificacoes: string;
  whatsappMarketing: string | null;
  rodadasHabilitadas: boolean;
  atualizadoEm: Date | null;
}

export const SORTE_MENSAGEM_CONVITE_PADRAO =
  'Olá, sou associado da Mais Prime e gostaria de saber sobre a promoção do associado da sorte';

/** Padrões dos campos v2 (sem linha gravada em `SorteConfig`). */
export const SORTE_CONFIG_V2_PADRAO = {
  produtoSgaCodigo: '3677',
  produtoSgaDescricao: 'ASSOCIADO DA SORTE',
  inscricaoValidadeHoras: 6,
  raspadasPorDia: 1,
  intervaloMinimoMinutos: 0,
  jornadaAtiva: false,
  lembretesAtivos: true,
  lembreteInicio: '08:00',
  lembreteFim: '21:00',
  whatsappConvite: null,
  mensagemConvite: SORTE_MENSAGEM_CONVITE_PADRAO,
  emailNotificacoes: 'marketing@teste.com.br',
  whatsappMarketing: null,
  rodadasHabilitadas: false,
} as const;

export const SORTE_FAIXAS_PADRAO: SorteFaixaRaspadinha[] = [
  { creditos: 1, peso: 60 },
  { creditos: 3, peso: 30 },
  { creditos: 10, peso: 10 },
];

export const SORTE_MARCOS_PADRAO: SorteMarcoSequencia[] = [
  { dias: 3, bonus: 2 },
  { dias: 7, bonus: 10 },
];

export function toConfigView(
  baseOrigin: string,
  config: SorteConfig | null,
): SorteConfigView {
  if (!config) {
    return {
      baseOrigin,
      ativa: false,
      titulo: 'Associado da Sorte',
      subtitulo: 'Junte créditos todos os dias e concorra a prêmios',
      regulamento: null,
      regulamentoAtualizadoEm: null,
      whatsappSuporte: null,
      fonteCreditoDiario: 'RASPADINHA',
      faixasRaspadinha: SORTE_FAIXAS_PADRAO,
      creditosCheckin: 1,
      marcosSequencia: SORTE_MARCOS_PADRAO,
      exibirGanhadores: true,
      carenciaDias: 0,
      ...SORTE_CONFIG_V2_PADRAO,
      atualizadoEm: null,
    };
  }
  return {
    baseOrigin: config.baseOrigin,
    ativa: config.ativa,
    titulo: config.titulo,
    subtitulo: config.subtitulo,
    regulamento: config.regulamento,
    regulamentoAtualizadoEm: config.regulamentoAtualizadoEm,
    whatsappSuporte: config.whatsappSuporte,
    fonteCreditoDiario: config.fonteCreditoDiario,
    faixasRaspadinha:
      config.faixasRaspadinha === null
        ? SORTE_FAIXAS_PADRAO
        : lerFaixas(config.faixasRaspadinha),
    creditosCheckin: config.creditosCheckin,
    marcosSequencia:
      config.marcosSequencia === null
        ? SORTE_MARCOS_PADRAO
        : lerMarcos(config.marcosSequencia),
    exibirGanhadores: config.exibirGanhadores,
    carenciaDias: config.carenciaDias,
    produtoSgaCodigo: config.produtoSgaCodigo,
    produtoSgaDescricao: config.produtoSgaDescricao,
    inscricaoValidadeHoras: config.inscricaoValidadeHoras,
    raspadasPorDia: config.raspadasPorDia,
    intervaloMinimoMinutos: config.intervaloMinimoMinutos,
    jornadaAtiva: config.jornadaAtiva,
    lembretesAtivos: config.lembretesAtivos,
    lembreteInicio: config.lembreteInicio,
    lembreteFim: config.lembreteFim,
    whatsappConvite: config.whatsappConvite,
    mensagemConvite: config.mensagemConvite,
    emailNotificacoes: config.emailNotificacoes,
    whatsappMarketing: config.whatsappMarketing,
    rodadasHabilitadas: config.rodadasHabilitadas,
    atualizadoEm: config.updatedAt,
  };
}

// ----------------------------------------------------------------- prêmios

export interface PremioAdminView {
  id: number;
  nome: string;
  descricao: string | null;
  imagemUrl: string | null;
  valorEstimado: number | null;
  estoque: number;
  /** Unidades comprometidas em rodadas publicadas. */
  reservado: number;
  disponivel: number;
  ativo: boolean;
  tipo: SortePremio['tipo'];
  custoCreditos: number;
  naLoja: boolean;
  limitePorAssociado: number;
  instrucoesRetirada: string | null;
  ordem: number;
  criadoEm: Date;
  atualizadoEm: Date;
}

export function toPremioAdmin(
  premio: SortePremio,
  reservado = 0,
): PremioAdminView {
  return {
    id: premio.id,
    nome: premio.nome,
    descricao: premio.descricao,
    imagemUrl: premio.imagemUrl,
    valorEstimado:
      premio.valorEstimado === null ? null : Number(premio.valorEstimado),
    estoque: premio.estoque,
    reservado,
    disponivel: Math.max(0, premio.estoque - reservado),
    ativo: premio.ativo,
    tipo: premio.tipo,
    custoCreditos: premio.custoCreditos,
    naLoja: premio.naLoja,
    limitePorAssociado: premio.limitePorAssociado,
    instrucoesRetirada: premio.instrucoesRetirada,
    ordem: premio.ordem,
    criadoEm: premio.createdAt,
    atualizadoEm: premio.updatedAt,
  };
}

export function toMovimentoEstoque(m: SorteEstoqueMovimento) {
  return {
    id: m.id,
    tipo: m.tipo,
    quantidade: m.quantidade,
    estoqueApos: m.estoqueApos,
    motivo: m.motivo,
    rodadaId: m.rodadaId,
    ganhadorId: m.ganhadorId,
    autor: m.autorNome ?? (m.autorId ? `Usuário #${m.autorId}` : 'Sistema'),
    criadoEm: m.createdAt,
  };
}

export interface PremioAppView {
  id: number;
  nome: string;
  descricao: string | null;
  imagemUrl: string | null;
  valorEstimado: number | null;
}

function toPremioApp(premio: SortePremio): PremioAppView {
  return {
    id: premio.id,
    nome: premio.nome,
    descricao: premio.descricao,
    imagemUrl: premio.imagemUrl,
    valorEstimado:
      premio.valorEstimado === null ? null : Number(premio.valorEstimado),
  };
}

// ----------------------------------------------------------------- rodadas

/** O que o painel ainda pode editar na rodada (seção 4.3). */
export type RodadaEdicao = 'TOTAL' | 'PARCIAL' | 'NENHUMA';

export function edicaoPermitida(
  rodada: { estado: SorteRodadaEstado; abertura: Date },
  agora: Date,
): RodadaEdicao {
  if (rodada.estado === SorteRodadaEstado.RASCUNHO) return 'TOTAL';
  if (rodada.estado !== SorteRodadaEstado.PUBLICADA) return 'NENHUMA';
  return agora.getTime() < rodada.abertura.getTime() ? 'TOTAL' : 'PARCIAL';
}

export function toRodadaAdmin(rodada: RodadaAdminRecord, agora: Date) {
  return {
    id: rodada.id,
    titulo: rodada.titulo,
    mecanica: rodada.mecanica,
    estado: rodada.estado,
    fase:
      rodada.estado === SorteRodadaEstado.RASCUNHO ||
      rodada.estado === SorteRodadaEstado.CANCELADA
        ? null
        : calcularFase(rodada, agora),
    quantidade: rodada.quantidade,
    quantidadeRestante: rodada.quantidadeRestante,
    custoCreditos: rodada.custoCreditos,
    modoCredito: rodada.modoCredito,
    bilhetesMaximos: rodada.bilhetesMaximos,
    abertura: rodada.abertura,
    encerramento: rodada.encerramento,
    baseOrigins: rodada.bases.map((b) => b.baseOrigin).sort(),
    premio: {
      id: rodada.premio.id,
      nome: rodada.premio.nome,
      imagemUrl: rodada.premio.imagemUrl,
      estoque: rodada.premio.estoque,
    },
    totalParticipantes: rodada._count.participacoes,
    totalGanhadores: rodada._count.ganhadores,
    apuradaEm: rodada.apuradaEm,
    resumoApuracao: rodada.resumoApuracao ?? null,
    lembreteEnviadoEm: rodada.lembreteEnviadoEm,
    edicao: edicaoPermitida(rodada, agora),
    criadoEm: rodada.createdAt,
    atualizadoEm: rodada.updatedAt,
  };
}

export type RodadaAdminView = ReturnType<typeof toRodadaAdmin>;

export function toParticipanteAdmin(p: ParticipanteRecord) {
  return {
    id: p.id,
    associado: {
      id: p.user.id,
      nome: p.user.name,
      cpfMascarado: mascararCpf(p.user.cpf),
    },
    baseOrigin: p.baseOrigin,
    bilhetes: p.bilhetes,
    creditosGastos: p.creditosGastos,
    estornadoEm: p.estornadoEm,
    inscritoEm: p.createdAt,
  };
}

/** Situação do próprio associado na rodada. */
export interface MinhaSituacaoNaRodada {
  participando: boolean;
  bilhetes: number;
  ganhou: boolean;
  ganhadorId: number | null;
  lembrete: boolean;
}

export interface RodadaAppView {
  id: number;
  titulo: string;
  mecanica: SorteMecanica;
  fase: SorteFase;
  abertura: Date;
  encerramento: Date;
  custoCreditos: number;
  modoCredito: 'CONSOME' | 'SALDO_MINIMO';
  bilhetesMaximos: number;
  quantidade: number;
  unidadesRestantes: number;
  totalParticipantes: number;
  premio: PremioAppView;
  minha: MinhaSituacaoNaRodada;
}

export const SITUACAO_VAZIA: MinhaSituacaoNaRodada = {
  participando: false,
  bilhetes: 0,
  ganhou: false,
  ganhadorId: null,
  lembrete: false,
};

export function toRodadaApp(
  rodada: RodadaAppRecord,
  agora: Date,
  minha: MinhaSituacaoNaRodada = SITUACAO_VAZIA,
): RodadaAppView {
  return {
    id: rodada.id,
    titulo: rodada.titulo?.trim() || rodada.premio.nome,
    mecanica: rodada.mecanica,
    fase: calcularFase(rodada, agora),
    abertura: rodada.abertura,
    encerramento: rodada.encerramento,
    custoCreditos: rodada.custoCreditos,
    modoCredito: rodada.modoCredito,
    bilhetesMaximos: rodada.bilhetesMaximos,
    quantidade: rodada.quantidade,
    unidadesRestantes: Math.max(0, rodada.quantidadeRestante),
    totalParticipantes: rodada._count.participacoes,
    premio: toPremioApp(rodada.premio),
    minha,
  };
}

// -------------------------------------------------------------- ganhadores

function rodadaDoGanhador(g: GanhadorRecord) {
  if (!g.rodada) return null;
  return {
    id: g.rodada.id,
    titulo: g.rodada.titulo?.trim() || g.premio.nome,
    mecanica: g.rodada.mecanica,
    abertura: g.rodada.abertura,
  };
}

/** Mensagem pronta do botão "Falar com a equipe" (app → suporte da base). */
export function mensagemDoGanhador(g: GanhadorRecord): string {
  if (g.origem === 'LOJA') {
    return `Olá! Comprei "${g.premio.nome}" na Loja da Sorte. Meu código do pedido é ${g.codigo}.`;
  }
  return `Olá! Ganhei o prêmio "${g.premio.nome}" no Associado da Sorte. Meu código é ${g.codigo}.`;
}

/** Mensagem pronta do botão "Chamar no WhatsApp" (painel → ganhador). */
export function mensagemParaGanhador(g: GanhadorRecord): string {
  const primeiroNome = nomePublico(g.user.name).split(' ')[0];
  if (g.origem === 'LOJA') {
    return `Olá, ${primeiroNome}! Aqui é da equipe Mais Prime. Recebemos seu pedido "${g.premio.nome}" na Loja da Sorte (código ${g.codigo}). Vamos combinar a retirada?`;
  }
  return `Olá, ${primeiroNome}! Aqui é da equipe Mais Prime. Você ganhou o prêmio "${g.premio.nome}" no Associado da Sorte (código ${g.codigo}). Vamos combinar a entrega?`;
}

export function toGanhadorAdmin(g: GanhadorRecord) {
  return {
    id: g.id,
    codigo: g.codigo,
    situacao: g.situacao,
    origem: g.origem,
    baseOrigin: g.baseOrigin,
    telefoneContato: g.telefoneContato,
    telefoneConfirmadoEm: g.telefoneConfirmadoEm,
    /** `null` enquanto o ganhador não confirmar o número no app. */
    linkWhatsapp: linkWhatsapp(g.telefoneContato, mensagemParaGanhador(g)),
    observacao: g.observacao,
    creditosGastos: g.creditosGastos,
    estoqueDevolvido: g.estoqueDevolvido,
    associado: {
      id: g.user.id,
      nome: g.user.name,
      cpfMascarado: mascararCpf(g.user.cpf),
    },
    premio: {
      id: g.premio.id,
      nome: g.premio.nome,
      imagemUrl: g.premio.imagemUrl,
      tipo: g.premio.tipo,
    },
    /** `null` na compra da loja. */
    rodada: rodadaDoGanhador(g),
    ganhouEm: g.createdAt,
    entregueEm: g.entregueEm,
    canceladoEm: g.canceladoEm,
  };
}

export type GanhadorAdminView = ReturnType<typeof toGanhadorAdmin>;

export function toMeuPremio(g: GanhadorRecord, whatsappSuporte: string | null) {
  return {
    id: g.id,
    codigo: g.codigo,
    situacao: g.situacao,
    origem: g.origem,
    ganhouEm: g.createdAt,
    entregueEm: g.entregueEm,
    telefoneContato: g.telefoneContato,
    telefoneConfirmado: g.telefoneConfirmadoEm !== null,
    premio: {
      id: g.premio.id,
      nome: g.premio.nome,
      descricao: g.premio.descricao,
      imagemUrl: g.premio.imagemUrl,
      tipo: g.premio.tipo,
    },
    /** `null` na compra da loja. */
    rodada: g.rodada
      ? {
          id: g.rodada.id,
          titulo: g.rodada.titulo?.trim() || g.premio.nome,
          mecanica: g.rodada.mecanica,
        }
      : null,
    /** Texto de retirada do produto (compra da loja). */
    instrucoesRetirada: g.premio.instrucoesRetirada,
    whatsappSuporte,
    /** Link wa.me do suporte com a mensagem pronta (nome do prêmio + código). */
    linkWhatsappSuporte: linkWhatsapp(whatsappSuporte, mensagemDoGanhador(g)),
  };
}

export type MeuPremioView = ReturnType<typeof toMeuPremio>;

/** Lista pública: só "Samuel F.", prêmio e data. */
export function toGanhadorPublico(g: GanhadorRecord) {
  return {
    nome: nomePublico(g.user.name),
    premio: g.premio.nome,
    imagemUrl: g.premio.imagemUrl,
    ganhouEm: g.createdAt,
  };
}

// ---------------------------------------------------------------- créditos

export function toLancamento(l: SorteCreditoLancamento) {
  return {
    id: l.id,
    tipo: l.tipo,
    rotulo: SORTE_LANCAMENTO_LABELS[l.tipo] ?? l.tipo,
    valor: l.valor,
    saldoApos: l.saldoApos,
    descricao: l.descricao,
    rodadaId: l.rodadaId,
    criadoEm: l.createdAt,
  };
}

export function toLancamentoAdmin(l: SorteCreditoLancamento) {
  return {
    ...toLancamento(l),
    baseOrigin: l.baseOrigin,
    autor: l.autorNome ?? (l.autorId ? `Usuário #${l.autorId}` : null),
  };
}

export function toAssociadoAdmin(u: AssociadoComCarteira) {
  return {
    id: u.id,
    nome: u.name,
    cpfMascarado: mascararCpf(u.cpf),
    baseOrigin: u.baseOrigin,
    ativo: u.isActive,
    saldo: u.sorteCarteira?.saldo ?? 0,
    totalGanho: u.sorteCarteira?.totalGanho ?? 0,
    sequenciaDias: u.sorteCarteira?.sequenciaDias ?? 0,
    /** `null` enquanto ninguém verificou (o app verifica no primeiro acesso). */
    inscricao: u.sorteInscricao ? toInscricaoView(u.sorteInscricao) : null,
  };
}

export function toInscricaoView(i: SorteInscricao) {
  return {
    inscrito: i.inscrito,
    fonte: i.fonte,
    verificadoEm: i.verificadoEm,
    codigoVeiculo: i.codigoVeiculo,
    autor: i.autorNome ?? (i.autorId ? `Usuário #${i.autorId}` : null),
    motivo: i.motivo,
    atualizadoEm: i.updatedAt,
  };
}

// --------------------------------------------------------------- campanhas

export function toCampanhaAdmin(
  c: SorteCampanha,
  contagem: ContagemMomentos | undefined,
) {
  return {
    id: c.id,
    baseOrigin: c.baseOrigin,
    nome: c.nome,
    inicio: c.inicio,
    fim: c.fim,
    estado: c.estado,
    /** `true` depois de publicada: cronograma e período não mudam mais. */
    travada: c.estado !== 'RASCUNHO',
    publicadaEm: c.publicadaEm,
    publicadaPor:
      c.publicadaPorNome ??
      (c.publicadaPorId ? `Usuário #${c.publicadaPorId}` : null),
    hashCronograma: c.hashCronograma,
    encerradaEm: c.encerradaEm,
    encerradaPor:
      c.encerradaPorNome ??
      (c.encerradaPorId ? `Usuário #${c.encerradaPorId}` : null),
    motivoEncerramento: c.motivoEncerramento,
    momentos: contagem ?? {
      total: 0,
      ganhos: 0,
      disponiveis: 0,
      aguardando: 0,
      creditosTotal: 0,
      creditosGanhos: 0,
    },
    criadoEm: c.createdAt,
    atualizadoEm: c.updatedAt,
  };
}

export type CampanhaAdminView = ReturnType<typeof toCampanhaAdmin>;

export function statusDoMomento(
  m: { userId: number | null; liberaEm: Date },
  agora: Date,
): SorteMomentoStatus {
  if (m.userId !== null) return 'GANHO';
  return m.liberaEm.getTime() <= agora.getTime() ? 'DISPONIVEL' : 'AGUARDANDO';
}

export function toMomentoAdmin(
  m: MomentoComGanhador,
  agora: Date,
  raspadaEm: Date | null = null,
) {
  return {
    id: m.id,
    liberaEm: m.liberaEm,
    creditos: m.creditos,
    descricao: m.descricao,
    status: statusDoMomento(m, agora),
    ganhador: m.ganhador
      ? {
          id: m.ganhador.id,
          nome: m.ganhador.name,
          cpfMascarado: mascararCpf(m.ganhador.cpf),
        }
      : null,
    ganhoEm: m.ganhoEm,
    raspadaId: m.raspadaId,
    raspadaEm,
  };
}

// --------------------------------------------- raspadas, tentativas, painel

export function toRaspadaView(r: SorteRaspada) {
  return {
    id: r.id,
    campanhaId: r.campanhaId,
    dia: r.dia.toISOString().slice(0, 10),
    resultado: r.resultado,
    creditos: r.creditos,
    bonus: r.bonus,
    momentoId: r.momentoId,
    criadoEm: r.createdAt,
  };
}

export function toTentativaView(t: SorteTentativa) {
  const acao = SORTE_TENTATIVA_ACAO_LABELS[t.acao] ?? t.acao;
  const motivo = SORTE_ERRO_LABELS[t.codigo] ?? t.codigo;
  return {
    id: t.id,
    acao: t.acao,
    codigo: t.codigo,
    /** "Tentou comprar na loja e não conseguiu: produto esgotado" */
    descricao: `Tentou ${acao} e não conseguiu: ${motivo}`,
    contexto: t.contexto ?? null,
    criadoEm: t.createdAt,
  };
}

export function toNotificacaoAdmin(
  n: SorteNotificacaoAdmin,
  linkWhatsappMarketing: string | null,
) {
  return {
    id: n.id,
    baseOrigin: n.baseOrigin,
    tipo: n.tipo,
    titulo: n.titulo,
    mensagem: n.mensagem,
    ganhadorId: n.ganhadorId,
    premioId: n.premioId,
    lida: n.lidaEm !== null,
    lidaEm: n.lidaEm,
    lidaPor: n.lidaPorNome ?? (n.lidaPorId ? `Usuário #${n.lidaPorId}` : null),
    /** Só NOVA_RETIRADA e só com `whatsappMarketing` configurado. */
    linkWhatsappMarketing,
    email: n.emailDestinatarios
      ? {
          destinatarios: n.emailDestinatarios
            .split(',')
            .map((e) => e.trim())
            .filter(Boolean),
          situacao: n.emailEnviadoEm
            ? ('ENVIADO' as const)
            : n.emailErro
              ? ('FALHOU' as const)
              : ('PENDENTE' as const),
          enviadoEm: n.emailEnviadoEm,
          erro: n.emailErro,
        }
      : null,
    criadoEm: n.createdAt,
  };
}

/** Produto da Loja da Sorte como o app vê. */
export function toProdutoLoja(
  p: SortePremio,
  compras: number,
  estoqueBaixo: number,
) {
  const esgotado = p.estoque <= 0;
  const atingiuLimite =
    p.limitePorAssociado > 0 && compras >= p.limitePorAssociado;
  return {
    id: p.id,
    nome: p.nome,
    descricao: p.descricao,
    imagemUrl: p.imagemUrl,
    tipo: p.tipo,
    custoCreditos: p.custoCreditos,
    estoque: Math.max(0, p.estoque),
    esgotado,
    ultimasUnidades: !esgotado && p.estoque <= estoqueBaixo,
    limitePorAssociado: p.limitePorAssociado,
    minhasCompras: compras,
    atingiuLimite,
  };
}

export function toColetaView(coleta: SorteColetaDiaria) {
  return {
    fonte: coleta.fonte,
    creditos: coleta.creditos,
    bonus: coleta.bonus,
    total: coleta.creditos + coleta.bonus,
    sequencia: coleta.sequencia,
    coletadoEm: coleta.createdAt,
  };
}
