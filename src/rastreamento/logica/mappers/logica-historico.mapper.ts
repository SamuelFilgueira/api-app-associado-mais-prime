import {
  TrajetoParada,
  TrajetoPosicao,
  TrajetoRelatorio,
} from '../dto/trajeto.dto';
import { LogicaVeiculoInfo } from '../services/trajetos.service';
import {
  DiaItemTrajetoDto,
  DiaResumoDto,
} from 'src/rastreamento/softruck/dto/historico-resumo-response.dto';
import {
  HistoricoSegmentoDto,
  VehicleInfoDto,
} from 'src/rastreamento/softruck/dto/historico-response.dto';
import { SoftruckGeomFeature } from 'src/rastreamento/softruck/interfaces/softruck-trajectories.interface';
import { converterAccParaData } from 'src/rastreamento/softruck/utils/period.utils';

// ============================================================
// Constantes de segmentação de viagens
// ============================================================

/*
 * Algoritmo replicado do relatório oficial "Parada/Deslocamento" da própria
 * plataforma da Lógica (engenharia reversa validada contra 5 deslocamentos
 * reais do relatório):
 *
 * - SOMENTE `posicoes[]` é usado. O array `paradas[]` da API é um cálculo
 *   paralelo e inconsistente (paradas sem posição correspondente na trilha,
 *   horários divergentes) — é ignorado por completo.
 * - Parada: começa na primeira posição com velocidade === 0 e continua
 *   enquanto a posição seguinte tem velocidade === 0 OU coordenada idêntica
 *   à da posição que iniciou a parada (o rastreador emite fixes com
 *   velocidade baixa mas coordenada congelada enquanto o veículo ainda está
 *   estacionado). Termina na primeira posição com velocidade > 0 E
 *   coordenada diferente da inicial.
 * - Deslocamento: para cada par de paradas consecutivas, início = primeira
 *   posição com velocidade > 0 a partir do COMEÇO da parada anterior (pode
 *   estar dentro dela — reproduz o relatório oficial); fim = posição em que
 *   a parada seguinte começa.
 * - NENHUM filtro de duração/distância mínima nem simplificação de pontos:
 *   todo deslocamento entre paradas é emitido com a trilha completa, como na
 *   plataforma. A ignição não é confiável (vem vazia/DESLIGADA mesmo em
 *   movimento) e não participa da segmentação.
 */

/** Offset fixo de America/Sao_Paulo (Brasil não tem DST desde 2019) */
const TZ_OFFSET_SECONDS = 3 * 3600;

/**
 * Raio EQUATORIAL da Terra (WGS84). A plataforma da Lógica usa este raio no
 * cálculo de distância — validado contra o PDF oficial: com o raio médio
 * (6371 km) as distâncias saem ~0,11% menores (ex.: 27.06 vs 27.09 km).
 */
const EARTH_RADIUS_LOGICA_M = 6_378_137;

/** Haversine com o raio usado pela plataforma da Lógica */
function haversineLogicaMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_LOGICA_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// Tipos
// ============================================================

/** Ponto da linha do tempo da Lógica já convertido para epoch segundos */
export interface PontoLogica {
  /** Epoch unix em segundos */
  ts: number;
  lat: number;
  lng: number;
  /** Velocidade em km/h */
  velocidade: number;
  ignicao: string;
  endereco?: string;
  equipamentoId?: number;
  equipamentoCodigo?: string;
  eventoNome?: string | null;
}

/** Viagem segmentada a partir do relatório da Lógica */
export interface ViagemLogica {
  /** Epoch segundos */
  inicioTs: number;
  fimTs: number;
  inicioLat: number;
  inicioLng: number;
  inicioEndereco?: string;
  fimLat: number;
  fimLng: number;
  fimEndereco?: string;
  duracaoSegundos: number;
  distanciaMetros: number;
  /** km/h — média aritmética das velocidades do intervalo (zeros incluídos) */
  velocidadeMedia: number;
  velocidadeMaxima: number;
  /**
   * Trilha completa do deslocamento: do ponto-âncora (último fix antes do
   * primeiro em movimento) até o primeiro ponto da parada seguinte — mesmo
   * intervalo usado no cálculo da distância. Sem simplificação.
   */
  pontos: PontoLogica[];
}

/** Bloco de parada detectado na trilha (índices sobre o array de pontos) */
interface BlocoParada {
  /** Índice da primeira posição da parada (velocidade === 0) */
  startIdx: number;
  /**
   * Índice da posição que encerrou a parada (velocidade > 0 E coordenada
   * diferente da inicial); igual a pontos.length quando a trilha termina
   * com o veículo parado.
   */
  terminatorIdx: number;
}

// ============================================================
// Conversão de data/hora (helper ÚNICO dos dois endpoints)
// ============================================================

/**
 * Converte data BR "dd/MM/yyyy HH:mm[:ss]" (horário local -03:00) em epoch
 * unix REAL em segundos. Retorna null quando a data é inválida.
 *
 * OBS: o parseDataBrParaTimestamp do TrajetosService usa Date.UTC direto
 * (serve só para ordenação) — aqui o epoch precisa ser real, pois o app
 * compara estes valores com Date.getTime() dos ISO do /resumo.
 */
export function parseDataBrParaEpochSeconds(data: string): number | null {
  const match = String(data ?? '')
    .trim()
    .match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) return null;

  const [, dia, mes, ano, hora, minuto, segundo] = match;
  const utcMs = Date.UTC(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    Number(hora),
    Number(minuto),
    Number(segundo ?? '0'),
  );

  if (!Number.isFinite(utcMs)) return null;

  // O wall clock é -03:00, logo o instante real é 3h depois do "UTC ingênuo"
  return utcMs / 1000 + TZ_OFFSET_SECONDS;
}

/**
 * Converte qualquer formato de data emitido pela Lógica em epoch segundos:
 * - "dd/MM/yyyy HH:mm[:ss]" (formato do /mobile/trajeto)
 * - "yyyy-MM-dd HH:mm:ss[.SSS]" (formato do /mobile/posicao)
 * Ambos em horário local -03:00. Retorna null quando inválida.
 */
export function parseDataLogicaParaEpochSeconds(data: string): number | null {
  const br = parseDataBrParaEpochSeconds(data);
  if (br !== null) return br;

  const match = String(data ?? '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);

  if (!match) return null;

  const [, ano, mes, dia, hora, minuto, segundo] = match;
  const utcMs = Date.UTC(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    Number(hora),
    Number(minuto),
    Number(segundo),
  );

  if (!Number.isFinite(utcMs)) return null;

  return utcMs / 1000 + TZ_OFFSET_SECONDS;
}

/**
 * Formata um epoch segundos como ISO 8601 com offset explícito -03:00
 * ("2026-08-11T08:05:59-03:00"). Inversa exata de parseDataBrParaEpochSeconds:
 * new Date(formatarActIso(ts)).getTime() / 1000 === ts.
 */
export function formatarActIso(epochSeconds: number): string {
  const local = new Date((epochSeconds - TZ_OFFSET_SECONDS) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}-03:00`
  );
}

/** Converte epoch segundos para o dia local (-03:00) no formato YYYYMMDD */
export function epochParaAcc(epochSeconds: number): number {
  const local = new Date((epochSeconds - TZ_OFFSET_SECONDS) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');

  return Number(
    `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}`,
  );
}

// ============================================================
// Segmentação de viagens
// ============================================================

/**
 * Converte posicoes[] cruas para PontoLogica, usando dataTz (epoch ms) quando
 * presente e caindo para o parse da data BR. Posições sem coordenada ou sem
 * timestamp válido são descartadas. A ordenação por ts é estável: timestamps
 * duplicados preservam a ordem original do array.
 */
function converterPosicoes(posicoes: TrajetoPosicao[]): PontoLogica[] {
  const pontos: PontoLogica[] = [];

  for (const posicao of posicoes) {
    if (
      typeof posicao?.latitude !== 'number' ||
      typeof posicao?.longitude !== 'number' ||
      !Number.isFinite(posicao.latitude) ||
      !Number.isFinite(posicao.longitude)
    ) {
      continue;
    }

    // Fixes sem sinal de GPS (satelite=0) — a plataforma os descarta antes
    // de montar o relatório; mantê-los criaria paradas/fronteiras a mais
    if (posicao.posicaoValida === false) continue;

    const ts =
      typeof posicao.dataTz === 'number' && posicao.dataTz > 0
        ? Math.round(posicao.dataTz / 1000)
        : parseDataLogicaParaEpochSeconds(posicao.data);

    if (ts === null) continue;

    pontos.push({
      ts,
      lat: posicao.latitude,
      lng: posicao.longitude,
      velocidade: Number(posicao.velocidade) || 0,
      ignicao: posicao.ignicao ?? '',
      endereco: posicao.endereco || undefined,
      equipamentoId: posicao.equipamentoId,
      equipamentoCodigo: posicao.equipamentoCodigo,
      eventoNome: posicao.eventoNome,
    });
  }

  pontos.sort((a, b) => a.ts - b.ts);
  return pontos;
}

/**
 * Detecta os blocos de parada na trilha (passada única).
 * Fora de uma parada, uma posição com velocidade === 0 inicia um bloco;
 * dentro dele, zeros e fixes com coordenada congelada (idêntica à da posição
 * inicial) continuam o bloco — mesmo com velocidade > 0. O bloco termina na
 * primeira posição com velocidade > 0 E coordenada diferente da inicial.
 */
function detectarParadas(pontos: PontoLogica[]): BlocoParada[] {
  const paradas: BlocoParada[] = [];
  let i = 0;

  while (i < pontos.length) {
    if (pontos[i].velocidade !== 0) {
      i++;
      continue;
    }

    const startIdx = i;
    const inicial = pontos[startIdx];
    let j = startIdx + 1;

    while (
      j < pontos.length &&
      (pontos[j].velocidade === 0 ||
        (pontos[j].lat === inicial.lat && pontos[j].lng === inicial.lng))
    ) {
      j++;
    }

    paradas.push({ startIdx, terminatorIdx: j });
    i = j;
  }

  return paradas;
}

/** Índice da primeira posição com velocidade > 0 em [de, ate), ou -1 */
function primeiraEmMovimento(
  pontos: PontoLogica[],
  de: number,
  ate: number,
): number {
  for (let i = de; i < ate; i++) {
    if (pontos[i].velocidade > 0) return i;
  }
  return -1;
}

/**
 * true quando todos os fixes de (deIdx, ateIdx] estão na MESMA coordenada do
 * fix deIdx — ou seja, o trecho não tem deslocamento real (fixes com
 * velocidade > 0 mas GPS congelado no mesmo ponto).
 */
function trechoSemDeslocamentoReal(
  pontos: PontoLogica[],
  deIdx: number,
  ateIdx: number,
): boolean {
  const base = pontos[deIdx];
  for (let i = deIdx + 1; i <= ateIdx; i++) {
    if (pontos[i].lat !== base.lat || pontos[i].lng !== base.lng) return false;
  }
  return true;
}

/**
 * Materializa um deslocamento entre os índices [inicioIdx, fimIdx].
 *
 * - Métricas de velocidade: intervalo semiaberto [inicioIdx, fimIdx) — inclui
 *   a posição inicial, exclui a final; zeros intermediários ENTRAM na média
 *   (comportamento validado contra o relatório oficial).
 * - Duração: ts(fim) - ts(inicio).
 * - Distância e trilha: intervalo mais largo [âncora, fimIdx], onde âncora é
 *   o ponto imediatamente anterior ao início (último fix da parada anterior)
 *   — captura o trecho percorrido antes do primeiro fix em movimento e até o
 *   primeiro ponto da parada seguinte; sem isso a distância sai ~30% menor.
 */
function montarViagem(
  pontos: PontoLogica[],
  inicioIdx: number,
  fimIdx: number,
): ViagemLogica | null {
  if (fimIdx <= inicioIdx) return null;

  const inicio = pontos[inicioIdx];
  const fim = pontos[fimIdx];

  let somaVelocidades = 0;
  let velocidadeMaxima = 0;

  for (let i = inicioIdx; i < fimIdx; i++) {
    somaVelocidades += pontos[i].velocidade;
    velocidadeMaxima = Math.max(velocidadeMaxima, pontos[i].velocidade);
  }

  const velocidadeMedia = Number(
    (somaVelocidades / (fimIdx - inicioIdx)).toFixed(2),
  );

  const anchorIdx = Math.max(0, inicioIdx - 1);

  let distanciaMetros = 0;
  for (let i = anchorIdx + 1; i <= fimIdx; i++) {
    distanciaMetros += haversineLogicaMeters(
      pontos[i - 1].lat,
      pontos[i - 1].lng,
      pontos[i].lat,
      pontos[i].lng,
    );
  }

  // Trilha completa, sem simplificação. O ponto-âncora pode ser anterior ao
  // início do deslocamento; o app filtra os pontos do mapa pela janela
  // [inicio.act, fim.act], então o ts dele é grampeado ao início para o
  // trecho inicial também ser desenhado.
  const trilha = pontos.slice(anchorIdx, fimIdx + 1);
  if (trilha[0].ts < inicio.ts) {
    trilha[0] = { ...trilha[0], ts: inicio.ts };
  }

  return {
    inicioTs: inicio.ts,
    fimTs: fim.ts,
    inicioLat: inicio.lat,
    inicioLng: inicio.lng,
    inicioEndereco: inicio.endereco,
    fimLat: fim.lat,
    fimLng: fim.lng,
    fimEndereco: fim.endereco,
    duracaoSegundos: fim.ts - inicio.ts,
    distanciaMetros: Math.round(distanciaMetros),
    velocidadeMedia,
    velocidadeMaxima,
    pontos: trilha,
  };
}

/**
 * Segmenta o relatório da Lógica em deslocamentos a partir SOMENTE de
 * posicoes[] (paradas[] é ignorado — ver cabeçalho do arquivo).
 *
 * Para cada par de paradas consecutivas: início = primeira posição em
 * movimento a partir do começo da parada anterior; fim = posição em que a
 * parada seguinte começa. Sem posição em movimento entre as duas, nada é
 * emitido. Movimento antes da primeira parada / depois da última também vira
 * deslocamento (bordas do período). Nenhum filtro mínimo é aplicado.
 */
export function segmentarViagens(relatorio: TrajetoRelatorio): ViagemLogica[] {
  const pontos = converterPosicoes(
    Array.isArray(relatorio?.posicoes) ? relatorio.posicoes : [],
  );
  if (pontos.length === 0) return [];

  const paradas = detectarParadas(pontos);
  const viagens: ViagemLogica[] = [];

  const adicionar = (inicioIdx: number, fimIdx: number) => {
    if (inicioIdx === -1) return;
    const viagem = montarViagem(pontos, inicioIdx, fimIdx);
    if (viagem) viagens.push(viagem);
  };

  if (paradas.length === 0) {
    // Trilha inteira em movimento no período: um único deslocamento
    adicionar(primeiraEmMovimento(pontos, 0, pontos.length), pontos.length - 1);
    return viagens;
  }

  // Borda inicial: o período começa com o veículo já em movimento
  adicionar(primeiraEmMovimento(pontos, 0, paradas[0].startIdx), paradas[0].startIdx);

  // Deslocamento entre cada par de paradas consecutivas. Quando o trecho até
  // a parada seguinte não tem deslocamento real (todos os fixes na mesma
  // coordenada — veículo "ligou e não saiu do lugar"), essa parada NÃO é
  // fronteira: o deslocamento a atravessa e termina na próxima parada em
  // local diferente — comportamento validado contra o relatório oficial.
  let k = 0;
  while (k < paradas.length - 1) {
    const atual = paradas[k];
    let j = k + 1;

    const inicioIdx = primeiraEmMovimento(
      pontos,
      atual.startIdx,
      paradas[j].startIdx,
    );

    if (inicioIdx === -1) {
      k = j;
      continue;
    }

    while (
      j < paradas.length &&
      trechoSemDeslocamentoReal(pontos, inicioIdx, paradas[j].startIdx)
    ) {
      j++;
    }

    if (j >= paradas.length) break; // só fixes congelados até a última parada

    adicionar(inicioIdx, paradas[j].startIdx);
    k = j;
  }

  // Borda final: o período termina com o veículo em movimento
  const ultima = paradas[paradas.length - 1];
  if (ultima.terminatorIdx < pontos.length) {
    adicionar(
      primeiraEmMovimento(pontos, ultima.startIdx, pontos.length),
      pontos.length - 1,
    );
  }

  // A passada única já produz os deslocamentos em ordem cronológica
  return viagens;
}

// ============================================================
// Enriquecimento de endereços
// ============================================================

/** Raio máximo para casar um extremo de viagem com uma parada da API */
const ENDERECO_RAIO_MAX_METROS = 500;

/**
 * Preenche os endereços de início/fim das viagens a partir de paradas[] do
 * /mobile/trajeto. As posições do /mobile/posicao não trazem endereço; as
 * paradas trazem — e são usadas SOMENTE como rótulo (nunca na segmentação).
 *
 * O casamento é ESPACIAL (parada mais próxima das coordenadas do extremo),
 * reproduzindo o relatório da plataforma: o fim de cada deslocamento coincide
 * com o ponto da parada seguinte, e o início é rotulado pelo endereço de onde
 * o movimento começou — não pelo endereço da parada em que o veículo estava
 * (o 1º fix em movimento sai a uma quadra do ponto de estacionamento; casar
 * por tempo devolveria o endereço errado, ex.: "Rua Abiru" em vez de
 * "Rua Umbelina Barcelos"). Endereços já presentes são preservados.
 */
export function enriquecerEnderecosComParadas(
  viagens: ViagemLogica[],
  paradas: TrajetoParada[],
): ViagemLogica[] {
  const pontosParada: { lat: number; lng: number; endereco: string }[] = [];

  for (const parada of Array.isArray(paradas) ? paradas : []) {
    const endereco = String(parada.endereco ?? '').trim();

    if (
      !endereco ||
      typeof parada.latitude !== 'number' ||
      typeof parada.longitude !== 'number' ||
      !Number.isFinite(parada.latitude) ||
      !Number.isFinite(parada.longitude)
    ) {
      continue;
    }

    pontosParada.push({
      lat: parada.latitude,
      lng: parada.longitude,
      endereco,
    });
  }

  if (pontosParada.length === 0) return viagens;

  const buscarEndereco = (lat: number, lng: number): string | undefined => {
    let melhor: string | undefined;
    let melhorDistancia = Infinity;

    for (const ponto of pontosParada) {
      const distancia = haversineLogicaMeters(lat, lng, ponto.lat, ponto.lng);
      if (distancia < melhorDistancia) {
        melhorDistancia = distancia;
        melhor = ponto.endereco;
      }
    }

    return melhorDistancia <= ENDERECO_RAIO_MAX_METROS ? melhor : undefined;
  };

  return viagens.map((viagem) => ({
    ...viagem,
    inicioEndereco:
      viagem.inicioEndereco ??
      buscarEndereco(viagem.inicioLat, viagem.inicioLng),
    fimEndereco:
      viagem.fimEndereco ?? buscarEndereco(viagem.fimLat, viagem.fimLng),
  }));
}

// ============================================================
// Mapeamento para o shape Softruck
// ============================================================

/**
 * Agrupa as viagens por dia (acc do início — viagem cruzando meia-noite
 * entra no dia em que começou) no shape do /resumo.
 */
export function mapearResumoDias(
  viagens: ViagemLogica[],
  veiculoId: number,
): DiaResumoDto[] {
  const porDia = new Map<number, DiaItemTrajetoDto[]>();

  for (const viagem of viagens) {
    const acc = epochParaAcc(viagem.inicioTs);

    const item: DiaItemTrajetoDto = {
      kind: 'TRAJECTORY',
      trajetoId: `logica-${veiculoId}-${viagem.inicioTs}`,
      inicio: {
        act: formatarActIso(viagem.inicioTs),
        adr: viagem.inicioEndereco,
      },
      fim: {
        act: formatarActIso(viagem.fimTs),
        adr: viagem.fimEndereco,
      },
      duracaoSegundos: viagem.duracaoSegundos,
      distanciaMetros: viagem.distanciaMetros,
      velocidadeMedia: viagem.velocidadeMedia,
      velocidadeMaxima: viagem.velocidadeMaxima,
    };

    const items = porDia.get(acc) ?? [];
    items.push(item);
    porDia.set(acc, items);
  }

  return [...porDia.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([acc, items]) => ({
      data: converterAccParaData(acc),
      acc,
      enterpriseId: '',
      items,
    }));
}

/** Converte as viagens para HistoricoSegmentoDto (sumário e segments do /rotas) */
export function mapearSegmentosHistorico(
  viagens: ViagemLogica[],
  veiculoId: number,
): HistoricoSegmentoDto[] {
  return viagens.map((viagem) => ({
    id: `logica-${veiculoId}-${viagem.inicioTs}`,
    acc: epochParaAcc(viagem.inicioTs),
    inicio: {
      act: formatarActIso(viagem.inicioTs),
      lat: viagem.inicioLat,
      lng: viagem.inicioLng,
      adr: viagem.inicioEndereco,
    },
    fim: {
      act: formatarActIso(viagem.fimTs),
      lat: viagem.fimLat,
      lng: viagem.fimLng,
      adr: viagem.fimEndereco,
    },
    duracaoSegundos: viagem.duracaoSegundos,
    distanciaMetros: viagem.distanciaMetros,
    velocidadeMaxima: viagem.velocidadeMaxima,
    velocidadeMedia: viagem.velocidadeMedia,
  }));
}

/**
 * Converte cada ponto das viagens em uma feature DETAILED no shape
 * SoftruckGeomFeature. O acc é do dia LOCAL do próprio ponto (viagem
 * cruzando meia-noite divide a polyline por dia, igual ao Softruck) e o
 * act usa a mesma conversão de epoch do /resumo — o app filtra os pontos
 * do mapa comparando os dois.
 */
export function mapearRotasFeatures(
  viagens: ViagemLogica[],
): SoftruckGeomFeature[] {
  const features: SoftruckGeomFeature[] = [];

  for (const viagem of viagens) {
    for (const ponto of viagem.pontos) {
      features.push({
        type: 'Feature',
        properties: {
          type: 'DETAILED',
          point: {
            did: ponto.equipamentoCodigo || String(ponto.equipamentoId ?? ''),
            acc: epochParaAcc(ponto.ts),
            lng: ponto.lng,
            lat: ponto.lat,
            ign: ponto.ignicao === 'LIGADA',
            tag: 'gps',
            val: '',
            msg: ponto.eventoNome ?? '',
            spd: ponto.velocidade,
            // dir omitido: a Lógica manda ponto cardinal ("NORTE"), não graus
            act: ponto.ts,
          },
        },
        geometry: {
          type: 'Point',
          coordinates: [ponto.lng, ponto.lat],
        },
      });
    }
  }

  return features;
}

/** Monta o VehicleInfoDto a partir do veículo do /listaVeiculo da Lógica */
export function mapearVehicleInfo(
  chassi: string,
  veiculo: LogicaVeiculoInfo,
): VehicleInfoDto {
  return {
    chassi,
    plate: veiculo.placa ?? '',
    brandName: veiculo.marca ?? '',
    modelName: veiculo.modelo ?? '',
  };
}
