import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';

/**
 * Única fonte de aleatoriedade do módulo (`crypto.randomInt`): valor da
 * raspadinha, sorteio de ganhadores e código do prêmio. Isolada em um
 * provider para os testes fixarem o resultado.
 */
@Injectable()
export class SorteAleatorioService {
  /** Inteiro uniforme em [0, maxExclusivo). */
  inteiro = (maxExclusivo: number): number => {
    if (!Number.isInteger(maxExclusivo) || maxExclusivo <= 1) return 0;
    return randomInt(maxExclusivo);
  };
}
