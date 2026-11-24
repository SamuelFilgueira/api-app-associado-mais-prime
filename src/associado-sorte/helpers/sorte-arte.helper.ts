import sharp from 'sharp';

/**
 * Arte da raspadinha (pedido do marketing, 23/11/2026).
 *
 * Três espaços, todos opcionais e independentes (vazio = visual padrão do app):
 *  - `capa`:      a "tinta" que o associado raspa. Só imagem ESTÁTICA: ela é
 *                 apagada pelo dedo por uma máscara, o que não funciona com
 *                 animação;
 *  - `ganhou`:    fundo revelado quando sai o voucher. Estática ou animada;
 *  - `naoGanhou`: fundo revelado no "não foi dessa vez". Estática ou animada.
 *
 * Vídeo (MP4/MOV) não é aceito: o app não tem player de vídeo, e incluir um
 * exigiria nova versão nas lojas. Animação é GIF ou WebP animado.
 *
 * Estas regras são a fonte única: o painel as lê em
 * `GET /admin/associado-sorte/arte/especificacao` e o guia para o marketing
 * (`docs/ASSOCIADO_DA_SORTE_ARTE_RASPADINHA.md`) repete os mesmos números.
 */

export const SORTE_ARTE_SLOTS = ['capa', 'ganhou', 'naoGanhou'] as const;
export type SorteArteSlot = (typeof SORTE_ARTE_SLOTS)[number];

export const SORTE_ARTE_ESPEC = {
  /** Largura ÷ altura da área da raspadinha no app. */
  proporcao: 2,
  /** Diferença relativa aceita na proporção (2 % ≈ 12 px em 600). */
  toleranciaProporcao: 0.02,
  recomendado: { largura: 1200, altura: 600 },
  estatica: {
    minimo: { largura: 900, altura: 450 },
    maxBytes: 1 * 1024 * 1024,
    formatos: ['png', 'jpeg', 'webp'],
  },
  animada: {
    recomendado: { largura: 800, altura: 400 },
    minimo: { largura: 600, altura: 300 },
    maximo: { largura: 1200, altura: 600 },
    maxBytes: 3 * 1024 * 1024,
    maxQuadros: 120,
    formatos: ['gif', 'webp'],
  },
  /** Limite do upload (o maior dos dois acima). */
  uploadMaxBytes: 3 * 1024 * 1024,
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  /** Margem interna sem texto/logo (cantos arredondados e corte de borda). */
  margemSegura: 0.06,
  /** Faixa inferior do `ganhou` onde o app escreve "+120 créditos". */
  faixaDoValor: 0.26,
} as const;

/** Campo de `SorteConfig` de cada espaço. */
export const SORTE_ARTE_CAMPO = {
  capa: 'arteCapaUrl',
  ganhou: 'arteGanhouUrl',
  naoGanhou: 'arteNaoGanhouUrl',
} as const satisfies Record<SorteArteSlot, string>;

export function ehSlotDeArte(valor: string): valor is SorteArteSlot {
  return (SORTE_ARTE_SLOTS as readonly string[]).includes(valor);
}

export interface ArteLida {
  formato: 'png' | 'jpeg' | 'webp' | 'gif';
  largura: number;
  altura: number;
  animada: boolean;
  quadros: number;
}

export type ArteValidada =
  | { ok: true; arte: ArteLida }
  | { ok: false; mensagem: string };

const mb = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;

/** Confere medidas, proporção, formato, animação e peso já conhecidos. */
export function conferirArte(
  slot: SorteArteSlot,
  arte: ArteLida,
  bytes: number,
): string | null {
  const e = SORTE_ARTE_ESPEC;
  if (arte.animada) {
    if (slot === 'capa') {
      return 'A capa da raspadinha precisa ser uma imagem estática (PNG, JPG ou WebP): ela é raspada pelo dedo, e isso não funciona com animação. Use a animação na arte de "ganhou" ou "não ganhou".';
    }
    if (bytes > e.animada.maxBytes) {
      return `Animação com ${mb(bytes)}: o limite é ${mb(e.animada.maxBytes)}. Reduza a duração, as cores ou as medidas (recomendado ${e.animada.recomendado.largura}×${e.animada.recomendado.altura} px).`;
    }
    if (arte.quadros > e.animada.maxQuadros) {
      return `Animação com ${arte.quadros} quadros: o limite é ${e.animada.maxQuadros} (cerca de 4 s a 30 qps).`;
    }
    if (
      arte.largura > e.animada.maximo.largura ||
      arte.altura > e.animada.maximo.altura
    ) {
      return `Animação com ${arte.largura}×${arte.altura} px: o máximo é ${e.animada.maximo.largura}×${e.animada.maximo.altura} px.`;
    }
  } else if (bytes > e.estatica.maxBytes) {
    return `Imagem com ${mb(bytes)}: o limite para imagem estática é ${mb(e.estatica.maxBytes)}.`;
  }
  const minimo = arte.animada ? e.animada.minimo : e.estatica.minimo;
  if (arte.largura < minimo.largura || arte.altura < minimo.altura) {
    return `Arte com ${arte.largura}×${arte.altura} px: o mínimo é ${minimo.largura}×${minimo.altura} px (recomendado ${e.recomendado.largura}×${e.recomendado.altura} px).`;
  }
  const proporcao = arte.largura / arte.altura;
  if (Math.abs(proporcao - e.proporcao) / e.proporcao > e.toleranciaProporcao) {
    return `Arte com ${arte.largura}×${arte.altura} px: a proporção precisa ser 2:1 (largura = 2 × altura), como ${e.recomendado.largura}×${e.recomendado.altura} px.`;
  }
  return null;
}

/** Lê o arquivo com o sharp e aplica `conferirArte`. */
export async function validarArte(
  slot: SorteArteSlot,
  arquivo: Buffer,
): Promise<ArteValidada> {
  let arte: ArteLida;
  try {
    const meta = await sharp(arquivo, { animated: true }).metadata();
    const formato = meta.format as string;
    if (!['png', 'jpeg', 'webp', 'gif'].includes(formato)) {
      return {
        ok: false,
        mensagem:
          'Formato não aceito. Envie PNG, JPG ou WebP (estática) ou GIF/WebP animado. Vídeo (MP4) não é aceito.',
      };
    }
    const quadros = meta.pages ?? 1;
    arte = {
      formato: formato as ArteLida['formato'],
      largura: meta.width ?? 0,
      // Em animações o sharp devolve a altura de todos os quadros empilhados.
      altura: meta.pageHeight ?? meta.height ?? 0,
      animada: quadros > 1,
      quadros,
    };
  } catch {
    return {
      ok: false,
      mensagem:
        'Não foi possível ler o arquivo como imagem. Envie PNG, JPG, WebP ou GIF.',
    };
  }
  const problema = conferirArte(slot, arte, arquivo.length);
  return problema ? { ok: false, mensagem: problema } : { ok: true, arte };
}
