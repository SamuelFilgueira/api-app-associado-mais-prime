/**
 * Mapeamento do retorno de `GET /associado/buscar/{cpf}` (SGA/Hinova) para os
 * campos cadastrais mantidos em `user`, e cálculo do que precisa ser gravado.
 *
 * Funções puras (sem I/O) para facilitar teste. A montagem do endereço
 * reproduz exatamente a de `AssociadoService.primeiroAcesso` (cadastro
 * inicial) — os dois precisam continuar idênticos para que um cadastro
 * recém-criado não seja detectado como "alterado" no primeiro login.
 */

/** Campos de `user` que a sincronização com o SGA pode atualizar. */
export type CamposCadastroSincronizados = {
  name: string;
  email: string;
  cep: string;
  address: string;
};

export type CampoCadastroSincronizado = keyof CamposCadastroSincronizados;

/** Cadastro extraído do SGA. `null` em um campo = SGA não informou. */
export type CadastroSga = {
  /** CPF somente dígitos, usado como trava de segurança. */
  cpf: string | null;
} & {
  [K in CampoCadastroSincronizado]: string | null;
};

/** Recorte do `user` local comparado com o SGA. */
export type CadastroLocal = {
  [K in CampoCadastroSincronizado]: string | null;
};

const CAMPOS_SINCRONIZADOS: CampoCadastroSincronizado[] = [
  'name',
  'email',
  'cep',
  'address',
];

/** Normaliza um valor vindo do SGA para string não vazia (ou `null`). */
function textoSga(valor: unknown): string | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    return String(valor);
  }
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  return texto.length > 0 ? texto : null;
}

/**
 * Monta o endereço no mesmo formato do cadastro inicial
 * (`[logradouro, numero, bairro, cidade].filter(Boolean).join(' ')`).
 */
export function montarEnderecoSga(dados: {
  logradouro?: unknown;
  numero?: unknown;
  bairro?: unknown;
  cidade?: unknown;
}): string | null {
  const endereco = [dados.logradouro, dados.numero, dados.bairro, dados.cidade]
    .filter(Boolean)
    .join(' ');

  return textoSga(endereco);
}

/**
 * Extrai os campos cadastrais do corpo retornado pelo SGA.
 *
 * Aceita objeto direto ou array com um elemento (os dois formatos já
 * observados na Hinova). Retorna `null` quando o corpo não se parece com um
 * associado (ex.: `{ mensagem, error }` em 2xx) — nesse caso nada é gravado.
 */
export function extrairCadastroSga(resposta: unknown): CadastroSga | null {
  const bruto: unknown = Array.isArray(resposta) ? resposta[0] : resposta;

  if (!bruto || typeof bruto !== 'object') return null;

  const dados = bruto as Record<string, unknown>;

  const email = textoSga(dados.email);

  const cadastro: CadastroSga = {
    cpf: textoSga(dados.cpf)?.replace(/\D/g, '') || null,
    name: textoSga(dados.nome),
    // E-mail sem "@" é lixo cadastral no SGA: mantém o local.
    email: email && email.includes('@') ? email : null,
    cep: textoSga(dados.cep),
    address: montarEnderecoSga(dados),
  };

  const temAlgumCampo = CAMPOS_SINCRONIZADOS.some(
    (campo) => cadastro[campo] !== null,
  );

  return temAlgumCampo ? cadastro : null;
}

/**
 * Devolve apenas os campos em que o SGA informou um valor **diferente** do
 * local. Campos ausentes/vazios no SGA nunca sobrescrevem o valor local.
 * Objeto vazio = nada a gravar (caminho comum: nenhuma escrita no banco).
 */
export function calcularAlteracoesCadastro(
  local: CadastroLocal,
  sga: CadastroSga,
): Partial<CamposCadastroSincronizados> {
  const alteracoes: Partial<CamposCadastroSincronizados> = {};

  for (const campo of CAMPOS_SINCRONIZADOS) {
    const valorSga = sga[campo];
    if (valorSga === null) continue;
    if (valorSga === local[campo]) continue;
    alteracoes[campo] = valorSga;
  }

  return alteracoes;
}
