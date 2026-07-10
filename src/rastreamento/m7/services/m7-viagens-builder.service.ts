import { Injectable, Logger } from '@nestjs/common';
import { BaseOrigin } from 'src/shared/token-resolver.service';
import {
  DiaM7ResumoDto,
  ViagemM7Dto,
} from '../dto/historico-m7-response.dto';
import {
  agruparViagensPorDia,
  formatarEnderecoM7,
  isEnderecoValido,
  truncarEndereco,
} from '../helpers/historico-m7-utils.helper';
import {
  M7PontoHistoricoRaw,
  M7TrajetoRaw,
} from '../interfaces/m7-historico.interface';
import { M7ReverseGeocodeService } from './m7-reverse-geocode.service';

@Injectable()
export class M7ViagensBuilderService {
  private readonly logger = new Logger(M7ViagensBuilderService.name);

  constructor(
    private readonly reverseGeocodeService: M7ReverseGeocodeService,
  ) {}

  construirViagensEDias(rawList: M7TrajetoRaw[]): {
    viagens: ViagemM7Dto[];
    dias: DiaM7ResumoDto[];
    distanciaTotalKm: number;
    velocidadeMaxima: number;
  } {
    const parseNum = (value: number | string | undefined): number => {
      const numero = Number(value ?? 0);
      return Number.isFinite(numero) ? numero : 0;
    };

    const isZeroTempo = (tempo: string | undefined): boolean => {
      if (!tempo) return true;
      return /^0{1,2}:0{1,2}:0{1,2}$/.test(tempo.trim());
    };

    const tempoEmSegundos = (tempo: string): number => {
      const parts = tempo.split(':');
      const h = parseInt(parts[0] ?? '0', 10) || 0;
      const m = parseInt(parts[1] ?? '0', 10) || 0;
      const s = parseInt(parts[2] ?? '0', 10) || 0;
      return h * 3600 + m * 60 + s;
    };

    const viagens: ViagemM7Dto[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const atual = rawList[i];
      if (atual.tipo !== 'VIAGEM') continue;

      const distanciaKm = parseNum(atual.distancia);
      const tempoMovimento = atual.tempo_movimento ?? '00:00:00';

      if (distanciaKm === 0 || isZeroTempo(tempoMovimento)) continue;
      if (tempoEmSegundos(tempoMovimento) <= 40) continue;

      let origemEndereco = '';
      for (let j = i - 1; j >= 0; j--) {
        const candidato = formatarEnderecoM7(String(rawList[j].destino ?? ''));
        if (isEnderecoValido(candidato)) {
          origemEndereco = candidato;
          break;
        }
      }

      const destinoBruto = formatarEnderecoM7(String(atual.destino ?? ''));
      let destinoEndereco = destinoBruto;
      if (!isEnderecoValido(destinoEndereco)) {
        for (let j = i + 1; j < rawList.length; j++) {
          const candidato = formatarEnderecoM7(
            String(rawList[j].destino ?? ''),
          );
          if (isEnderecoValido(candidato)) {
            destinoEndereco = candidato;
            break;
          }
        }
      }

      viagens.push({
        origem: origemEndereco,
        saida: String(atual.data_inicio ?? ''),
        destino: destinoEndereco,
        chegada: String(atual.data_fim ?? ''),
        distanciaKm,
        tempoMovimento,
        tempoParado: String(atual.tempo_parado ?? '00:00:00'),
        tempoTotal: String(atual.tempo_total ?? '00:00:00'),
        velocidadeMaxima: parseNum(atual.velocidade_maxima),
      });
    }

    const dias = agruparViagensPorDia(viagens);
    const distanciaTotalKm =
      Math.round(viagens.reduce((acc, viagem) => acc + viagem.distanciaKm, 0) * 100) /
      100;
    const velocidadeMaxima = viagens.reduce<number>(
      (max, viagem) => Math.max(max, viagem.velocidadeMaxima),
      0,
    );

    return { viagens, dias, distanciaTotalKm, velocidadeMaxima };
  }

  async construirViagensEDiasPorHistorico(
    pontosRaw: M7PontoHistoricoRaw[],
    baseOrigin: BaseOrigin,
  ): Promise<{
    viagens: ViagemM7Dto[];
    dias: DiaM7ResumoDto[];
    distanciaTotalKm: number;
    velocidadeMaxima: number;
  }> {
    const MOVING_SPEED_THRESHOLD = 3;
    const MAX_GAP_SECONDS = 600;
    const IGNITION_FALSE_BLIP_SECONDS = 120;
    const DISTANCIA_MINIMA_KM = 0.02;

    this.logger.log(
      `[${baseOrigin}] [V2] iniciar reconstrução por histórico | pontosRaw=${pontosRaw.length} thresholdMov=${MOVING_SPEED_THRESHOLD} maxGap=${MAX_GAP_SECONDS}s`,
    );

    type Ponto = {
      ts: Date;
      dataGps: string;
      codigoPosicao: number;
      ignicao: boolean;
      velocidade: number;
      odometro: number | null;
      lat: number | null;
      lon: number | null;
      cidade: string;
    };

    const pontos: Ponto[] = pontosRaw
      .map((ponto) => {
        const ts = this.parseDateTime(String(ponto.data_gps ?? ''));
        if (!ts) return null;

        return {
          ts,
          dataGps: String(ponto.data_gps ?? ''),
          codigoPosicao: Number(ponto.codigo_posicao ?? 0),
          ignicao: this.parseBooleanIgnicao(ponto.ignicao),
          velocidade: this.parseNumero(ponto.velocidade) ?? 0,
          odometro: this.parseNumero(ponto.odometro),
          lat: this.parseNumero(ponto.latitude),
          cidade: String(ponto.cidade ?? ''),
          lon: this.parseNumero(ponto.longitude),
        };
      })
      .filter((ponto): ponto is Ponto => Boolean(ponto))
      .sort((a, b) => {
        const diff = a.ts.getTime() - b.ts.getTime();
        return diff !== 0 ? diff : a.codigoPosicao - b.codigoPosicao;
      });

    this.logger.debug(
      `[${baseOrigin}] [V2] pontos normalizados=${pontos.length}`,
    );

    if (pontos.length > 0) {
      this.logger.debug(
        `[${baseOrigin}] [V2] janela pontos=${pontos[0].dataGps} .. ${pontos[pontos.length - 1].dataGps}`,
      );
    }

    if (pontos.length < 2) {
      this.logger.warn(
        `[${baseOrigin}] [V2] pontos insuficientes para reconstrução (normalizados=${pontos.length})`,
      );
      return {
        viagens: [],
        dias: [],
        distanciaTotalKm: 0,
        velocidadeMaxima: 0,
      };
    }

    const isMoving = (ponto: Ponto) => ponto.velocidade > MOVING_SPEED_THRESHOLD;

    const ignicaoSuavizada = pontos.map((ponto) => ponto.ignicao);
    let blipsIgnicaoCorrigidos = 0;

    for (let i = 1; i < pontos.length - 1; i++) {
      if (ignicaoSuavizada[i]) continue;
      if (!ignicaoSuavizada[i - 1]) continue;

      let j = i;
      while (j < pontos.length && !ignicaoSuavizada[j]) j++;
      if (j >= pontos.length) break;
      if (!ignicaoSuavizada[j]) continue;

      const duracaoSeg = Math.floor(
        (pontos[j].ts.getTime() - pontos[i].ts.getTime()) / 1000,
      );

      if (duracaoSeg <= IGNITION_FALSE_BLIP_SECONDS) {
        for (let k = i; k < j; k++) {
          ignicaoSuavizada[k] = true;
          blipsIgnicaoCorrigidos += 1;
        }
      }

      i = j - 1;
    }

    this.logger.log(
      `[${baseOrigin}] [V2] suavização ignição aplicada | falseBlipsCorrigidos=${blipsIgnicaoCorrigidos} janelaBlip=${IGNITION_FALSE_BLIP_SECONDS}s`,
    );

    const ciclos: Array<{ start: number; end: number }> = [];
    let inicioCiclo = -1;

    for (let i = 0; i < pontos.length; i++) {
      const ignicaoAtiva = ignicaoSuavizada[i];

      if (inicioCiclo === -1 && ignicaoAtiva) {
        inicioCiclo = i;
        continue;
      }

      if (inicioCiclo !== -1 && !ignicaoAtiva) {
        if (i > inicioCiclo) {
          ciclos.push({ start: inicioCiclo, end: i });
        }
        inicioCiclo = -1;
      }
    }

    if (inicioCiclo !== -1 && inicioCiclo < pontos.length - 1) {
      ciclos.push({ start: inicioCiclo, end: pontos.length - 1 });
    }

    this.logger.log(
      `[${baseOrigin}] [V2] ciclos de ignição detectados=${ciclos.length}`,
    );

    type ViagemIntermediaria = {
      saida: string;
      chegada: string;
      distanciaKm: number;
      tempoMovimento: string;
      tempoParado: string;
      tempoTotal: string;
      velocidadeMaxima: number;
      origemCoord: { lat: number; lon: number } | null;
      destinoCoord: { lat: number; lon: number } | null;
      origemCidade: string;
      destinoCidade: string;
    };

    const viagensIntermediarias: ViagemIntermediaria[] = [];
    const descartes = {
      seqCurta: 0,
      semMovimento: 0,
      movimentoInvalido: 0,
      distanciaZerada: 0,
      tempoMovCurto: 0,
    };

    for (const ciclo of ciclos) {
      const seq = pontos.slice(ciclo.start, ciclo.end + 1);
      if (seq.length < 2) {
        descartes.seqCurta += 1;
        continue;
      }

      const firstMoveIdx = seq.findIndex((ponto) => isMoving(ponto));
      if (firstMoveIdx === -1) {
        descartes.semMovimento += 1;
        continue;
      }

      let lastMoveIdx = -1;
      for (let i = seq.length - 1; i >= 0; i--) {
        if (isMoving(seq[i])) {
          lastMoveIdx = i;
          break;
        }
      }

      if (lastMoveIdx === -1 || lastMoveIdx <= firstMoveIdx) {
        descartes.movimentoInvalido += 1;
        continue;
      }

      const inicioEvento = seq[0];
      const fimEvento = seq[seq.length - 1];
      const inicioMov = seq[firstMoveIdx];
      const fimMov = seq[lastMoveIdx];

      const tempoTotalSec = Math.max(
        0,
        Math.floor((fimEvento.ts.getTime() - inicioEvento.ts.getTime()) / 1000),
      );

      let tempoMovSec = 0;
      let distanciaHaversineKm = 0;

      for (let i = 1; i < seq.length; i++) {
        const prev = seq[i - 1];
        const curr = seq[i];
        const dt = Math.floor((curr.ts.getTime() - prev.ts.getTime()) / 1000);
        if (dt <= 0 || dt > MAX_GAP_SECONDS) continue;

        const movingWindow = isMoving(prev) || isMoving(curr);
        if (movingWindow) {
          tempoMovSec += dt;
        }

        const dentroJanelaMov = i - 1 >= firstMoveIdx && i <= lastMoveIdx;
        if (
          dentroJanelaMov &&
          prev.lat !== null &&
          prev.lon !== null &&
          curr.lat !== null &&
          curr.lon !== null
        ) {
          distanciaHaversineKm += this.calcularDistanciaHaversineKm(
            prev.lat,
            prev.lon,
            curr.lat,
            curr.lon,
          );
        }
      }

      const tempoParadoSec = Math.max(0, tempoTotalSec - tempoMovSec);

      let distanciaKmBruta = distanciaHaversineKm;
      if (
        inicioMov.odometro !== null &&
        fimMov.odometro !== null &&
        fimMov.odometro > inicioMov.odometro
      ) {
        const deltaOdom = fimMov.odometro - inicioMov.odometro;
        if (deltaOdom > 0 && deltaOdom <= 2000) {
          distanciaKmBruta = deltaOdom;
        }
      }

      const distanciaKm = Math.round(distanciaKmBruta * 100) / 100;

      this.logger.debug(
        `[${baseOrigin}] [V2] ciclo saida=${inicioMov.dataGps} chegada=${fimMov.dataGps} haversineKm=${Math.round(distanciaHaversineKm * 100) / 100} distanciaKm=${distanciaKm} tempoMovSec=${tempoMovSec} seq=${seq.length}pts`,
      );

      if (distanciaKmBruta < DISTANCIA_MINIMA_KM) {
        descartes.distanciaZerada += 1;
        continue;
      }
      if (tempoMovSec <= 40) {
        descartes.tempoMovCurto += 1;
        continue;
      }

      const origemPonto = seq[Math.max(0, firstMoveIdx - 1)] ?? inicioMov;
      const destinoPonto =
        seq[Math.min(seq.length - 1, lastMoveIdx + 1)] ?? fimMov;

      viagensIntermediarias.push({
        saida: inicioMov.dataGps,
        chegada: fimMov.dataGps,
        distanciaKm,
        tempoMovimento: this.formatarDuracaoHms(tempoMovSec),
        tempoParado: this.formatarDuracaoHms(tempoParadoSec),
        tempoTotal: this.formatarDuracaoHms(tempoTotalSec),
        velocidadeMaxima: Math.max(...seq.map((ponto) => ponto.velocidade), 0),
        origemCoord:
          origemPonto.lat !== null && origemPonto.lon !== null
            ? { lat: origemPonto.lat, lon: origemPonto.lon }
            : null,
        destinoCoord:
          destinoPonto.lat !== null && destinoPonto.lon !== null
            ? { lat: destinoPonto.lat, lon: destinoPonto.lon }
            : null,
        origemCidade: origemPonto.cidade,
        destinoCidade: destinoPonto.cidade,
      });
    }

    this.logger.log(
      `[${baseOrigin}] [V2] funil ciclos=${ciclos.length} aprovados=${viagensIntermediarias.length} descartes={seqCurta:${descartes.seqCurta},semMovimento:${descartes.semMovimento},movInvalido:${descartes.movimentoInvalido},dist0:${descartes.distanciaZerada},tempo<=40s:${descartes.tempoMovCurto}}`,
    );

    const viagens: ViagemM7Dto[] = await Promise.all(
      viagensIntermediarias.map(async (viagem) => {
        const [origem, destino] = await Promise.all([
          viagem.origemCoord
            ? this.reverseGeocodeService.reverseGeocodeCoordenada(
                viagem.origemCoord.lat.toFixed(6),
                viagem.origemCoord.lon.toFixed(6),
                baseOrigin,
                this.reverseGeocodeService.normalizarCidadeM7(
                  viagem.origemCidade,
                ) ?? undefined,
              )
            : Promise.resolve('Referência de origem não encontrada'),
          viagem.destinoCoord
            ? this.reverseGeocodeService.reverseGeocodeCoordenada(
                viagem.destinoCoord.lat.toFixed(6),
                viagem.destinoCoord.lon.toFixed(6),
                baseOrigin,
                this.reverseGeocodeService.normalizarCidadeM7(
                  viagem.destinoCidade,
                ) ?? undefined,
              )
            : Promise.resolve('Referência de destino não encontrada'),
        ]);

        return {
          origem: truncarEndereco(
            origem || 'Referência de origem não encontrada',
          ),
          saida: viagem.saida,
          destino: truncarEndereco(
            destino || 'Referência de destino não encontrada',
          ),
          chegada: viagem.chegada,
          distanciaKm: viagem.distanciaKm,
          tempoMovimento: viagem.tempoMovimento,
          tempoParado: viagem.tempoParado,
          tempoTotal: viagem.tempoTotal,
          velocidadeMaxima: viagem.velocidadeMaxima,
        };
      }),
    );

    const origemResolvida = viagens.filter((viagem) =>
      isEnderecoValido(viagem.origem),
    ).length;
    const destinoResolvido = viagens.filter((viagem) =>
      isEnderecoValido(viagem.destino),
    ).length;

    this.logger.log(
      `[${baseOrigin}] [V2] geocode concluído viagens=${viagens.length} origemResolvida=${origemResolvida}/${viagens.length} destinoResolvido=${destinoResolvido}/${viagens.length}`,
    );

    const dias = agruparViagensPorDia(viagens);
    const distanciaTotalKm =
      Math.round(viagens.reduce((acc, viagem) => acc + viagem.distanciaKm, 0) * 100) /
      100;
    const velocidadeMaxima = viagens.reduce(
      (max, viagem) => Math.max(max, viagem.velocidadeMaxima),
      0,
    );

    this.logger.log(
      `[${baseOrigin}] [V2] resumo reconstrução dias=${dias.length} viagens=${viagens.length} distanciaTotalKm=${distanciaTotalKm} velocidadeMaxima=${velocidadeMaxima}`,
    );

    return { viagens, dias, distanciaTotalKm, velocidadeMaxima };
  }

  private parseBooleanIgnicao(valor: unknown): boolean {
    if (typeof valor === 'boolean') return valor;
    if (typeof valor === 'number') return valor !== 0;
    if (typeof valor === 'string') {
      const normalizado = valor.trim().toLowerCase();
      return (
        normalizado === '1' ||
        normalizado === 'true' ||
        normalizado === 'ligado' ||
        normalizado === 'on'
      );
    }
    return false;
  }

  private parseDateTime(valor: string | undefined): Date | null {
    if (!valor) return null;
    const iso = valor.includes('T') ? valor : valor.replace(' ', 'T');
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private formatarDuracaoHms(totalSeconds: number): string {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const h = String(Math.floor(safe / 3600)).padStart(2, '0');
    const m = String(Math.floor((safe % 3600) / 60)).padStart(2, '0');
    const s = String(safe % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  private calcularDistanciaHaversineKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (deg: number) => (deg * Math.PI) / 40;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private parseNumero(valor: number | string | undefined): number | null {
    if (valor === null || valor === undefined) return null;
    const numero = Number(String(valor).replace(',', '.'));
    return Number.isFinite(numero) ? numero : null;
  }
}