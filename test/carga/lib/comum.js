// Utilitários comuns aos roteiros de carga (k6). Ver ../README.md.
import http from 'k6/http';
import { check, fail } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(
  /\/+$/,
  '',
);

/** Número vindo de env, com padrão. */
export function numeroEnv(nome, padrao) {
  const valor = Number(__ENV[nome]);
  return __ENV[nome] !== undefined && __ENV[nome] !== '' && Number.isFinite(valor)
    ? valor
    : padrao;
}

/**
 * Usuários de teste.
 *
 * - Um só: envs CPF, SENHA, CHASSI, CNPJ.
 * - Vários: USUARIOS_ARQUIVO aponta para um JSON
 *   `[{ "cpf": "...", "senha": "...", "chassi": "...", "cnpj": "..." }, ...]`
 *   (caminho absoluto; no container, dentro de /scripts). Cada VU usa um
 *   usuário, em rodízio — necessário para medir sem esbarrar no limite por
 *   usuário da própria API e sem que um único cache responda por todos.
 */
export const USUARIOS = new SharedArray('usuarios', () => {
  if (__ENV.USUARIOS_ARQUIVO) {
    const lista = JSON.parse(open(__ENV.USUARIOS_ARQUIVO));
    if (!Array.isArray(lista) || lista.length === 0) {
      throw new Error('USUARIOS_ARQUIVO precisa ser um array JSON não vazio.');
    }
    return lista;
  }
  return [
    {
      cpf: __ENV.CPF,
      senha: __ENV.SENHA,
      chassi: __ENV.CHASSI,
      cnpj: __ENV.CNPJ,
    },
  ];
});

/**
 * Falha na carga do roteiro se faltar algum campo em algum usuário.
 * (Laços por índice: o SharedArray não é um Array de verdade.)
 */
export function exigirCampos(campos) {
  for (let i = 0; i < USUARIOS.length; i++) {
    for (let j = 0; j < campos.length; j++) {
      if (!USUARIOS[i][campos[j]]) {
        throw new Error(
          `Usuário de teste #${i + 1} sem "${campos[j]}". Defina as envs ` +
            `${campos.map((c) => c.toUpperCase()).join(', ')} ou USUARIOS_ARQUIVO.`,
        );
      }
    }
  }
}

/** Usuário do VU atual (rodízio). */
export function usuarioDoVu() {
  return USUARIOS[(__VU - 1) % USUARIOS.length];
}

/**
 * Trava de segurança, chamada no setup() de todo roteiro: carga contra
 * produção derruba o serviço para os associados e leva a Hinova a bloquear o
 * token da base. Exige a confirmação explícita AMBIENTE=homologacao.
 */
export function exigirHomologacao() {
  if ((__ENV.AMBIENTE || '').toLowerCase() !== 'homologacao') {
    fail(
      'Roteiro de carga bloqueado: rode só contra homologação com os vendors ' +
        `simulados e passe -e AMBIENTE=homologacao. Alvo atual: ${BASE_URL}`,
    );
  }
}

/**
 * Respostas 429. Em carga legítima deveria ser zero: se subir, quem está
 * respondendo é o limite de requisições (Nginx ou aplicação), não a API.
 */
export const respostas429 = new Counter('respostas_429');

/** Registra o 429 e devolve a própria resposta. */
export function observar(res) {
  if (res.status === 429) respostas429.add(1);
  return res;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Opções de requisição autenticada; `nome` agrupa a métrica por rota. */
export function autenticado(token, nome, extras = {}) {
  return {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    tags: { name: nome },
    ...extras,
  };
}

/**
 * POST /api/auth/login — corpo `{ cpf, password }`, resposta `{ access_token }`.
 * Devolve o token ou `null` (com o check marcado como falho).
 */
export function login(usuario) {
  const res = observar(
    http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ cpf: usuario.cpf, password: usuario.senha }),
      { headers: JSON_HEADERS, tags: { name: 'login' } },
    ),
  );

  let token = null;
  if (res.status === 200 || res.status === 201) {
    try {
      token = res.json('access_token') || null;
    } catch (_e) {
      token = null;
    }
  }
  check(res, { 'login devolveu access_token': () => token !== null });
  return token;
}

/** Faz o login de todos os usuários (para o setup()). Aborta se algum falhar. */
export function loginDeTodos() {
  const tokens = [];
  for (let i = 0; i < USUARIOS.length; i++) {
    const token = login(USUARIOS[i]);
    if (!token) {
      fail(
        `Login do usuário de teste #${i + 1} falhou. Confira CPF/senha e se a ` +
          'conta já passou pelo primeiro login.',
      );
    }
    tokens.push(token);
  }
  return tokens;
}

/** Data `YYYY-MM-DD` de hoje deslocada em `dias` (negativo = passado). */
export function dataRelativa(dias) {
  const data = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}
