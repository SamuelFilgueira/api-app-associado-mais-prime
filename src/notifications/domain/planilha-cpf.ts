/**
 * Regras da planilha de CPFs do disparo de situação de cadastro: validação
 * de CPF, correção de acentuação e separação dos CPFs entre quem recebe e
 * quem fica de fora (e por quê).
 */

/** Valida os dígitos verificadores do CPF (11 dígitos, já normalizado). */
export function validarDigitosCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf)) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calcularDigito = (tamanho: number): number => {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) {
      soma += parseInt(cpf[i], 10) * (tamanho + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return (
    calcularDigito(9) === parseInt(cpf[9], 10) &&
    calcularDigito(10) === parseInt(cpf[10], 10)
  );
}

/**
 * Normaliza o valor de uma célula para CPF: remove máscara e repõe zeros à
 * esquerda perdidos quando a célula do Excel é numérica.
 */
export function normalizarCpf(valorBruto: string): string | null {
  const digitos = valorBruto.replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.length > 11) return null;
  return digitos.padStart(11, '0');
}

export interface CpfsDaPlanilha {
  cpfs: string[];
  cpfsInvalidos: string[];
  totalLinhas: number;
  duplicadosRemovidos: number;
}

/** Separa os valores lidos da coluna em CPFs únicos válidos e inválidos. */
export function separarCpfs(valores: string[]): CpfsDaPlanilha {
  const unicos = new Set<string>();
  const cpfsInvalidos: string[] = [];
  let duplicadosRemovidos = 0;

  for (const valorBruto of valores) {
    const cpf = normalizarCpf(valorBruto);
    if (!cpf || !validarDigitosCpf(cpf)) {
      cpfsInvalidos.push(valorBruto);
    } else if (unicos.has(cpf)) {
      duplicadosRemovidos++;
    } else {
      unicos.add(cpf);
    }
  }

  return {
    cpfs: Array.from(unicos),
    cpfsInvalidos,
    totalLinhas: valores.length,
    duplicadosRemovidos,
  };
}

export interface UsuarioDaPlanilha {
  id: number;
  cpf: string;
  isActive: boolean;
  expoPushToken: string | null;
}

export interface SelecaoDaPlanilha {
  destinatarios: Array<{ userId: number; cpf: string; expoPushToken: string }>;
  cpfsNaoEncontrados: string[];
  cpfsInativos: string[];
  cpfsSemToken: string[];
}

/**
 * Quem da planilha recebe o push: usuário cadastrado, ativo e com token
 * válido. Sem filtro de opt-in de marketing (é aviso de cadastro, não
 * promoção).
 */
export function selecionarDestinatarios(
  cpfs: string[],
  usuarios: UsuarioDaPlanilha[],
  tokenValido: (token: unknown) => token is string,
): SelecaoDaPlanilha {
  const porCpf = new Map(usuarios.map((u) => [u.cpf, u]));
  const selecao: SelecaoDaPlanilha = {
    destinatarios: [],
    cpfsNaoEncontrados: [],
    cpfsInativos: [],
    cpfsSemToken: [],
  };

  for (const cpf of cpfs) {
    const usuario = porCpf.get(cpf);
    if (!usuario) {
      selecao.cpfsNaoEncontrados.push(cpf);
    } else if (!usuario.isActive) {
      selecao.cpfsInativos.push(cpf);
    } else if (!tokenValido(usuario.expoPushToken)) {
      selecao.cpfsSemToken.push(cpf);
    } else {
      selecao.destinatarios.push({
        userId: usuario.id,
        cpf: usuario.cpf,
        expoPushToken: usuario.expoPushToken,
      });
    }
  }
  return selecao;
}

/** Caracteres do cp1252 que ocupam a faixa 0x80–0x9F (ex.: €, ", –). */
const CP1252: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/**
 * Corrige texto que chegou com mojibake (UTF-8 lido como latin1/cp1252 —
 * ex.: "AtualizaÃ§Ã£o" em vez de "Atualização"). Texto já correto passa
 * intocado; a correção só é aplicada quando o padrão típico é detectado
 * e a re-decodificação produz UTF-8 válido.
 */
export function corrigirTextoUtf8(texto: string): string {
  if (!texto || !/[\u00C2\u00C3][\u0080-\u00BF]/.test(texto)) {
    return texto;
  }

  const bytes: number[] = [];
  for (const char of texto) {
    const code = char.codePointAt(0) as number;
    if (code <= 0xff) {
      bytes.push(code);
    } else if (CP1252[char] !== undefined) {
      bytes.push(CP1252[char]);
    } else {
      // Contém caractere fora do padrão de mojibake — não arriscar corrigir
      return texto;
    }
  }

  const decodificado = Buffer.from(bytes).toString('utf8');
  // Se a re-decodificação gerou caractere inválido, mantém o original
  return decodificado.includes('\uFFFD') ? texto : decodificado;
}
