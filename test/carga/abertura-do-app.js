// Linha de base: abertura do app.
//
// Sequência de cada iteração (as chamadas que o app faz ao abrir):
//   POST /api/auth/login            { cpf, password }  -> { access_token }
//   GET  /api/auth/me
//   GET  /api/sga/associado
//   GET  /api/sga/veiculos          -> lista com `codigo_veiculo`
//   POST /api/sga/boleto/listar     { codigo_veiculo }
//
// Modelo aberto (aberturas por segundo): a taxa de chegada não diminui quando
// a API fica lenta — é assim que os usuários de verdade se comportam.
//
// Envs: BASE_URL, CPF, SENHA (ou USUARIOS_ARQUIVO), AMBIENTE=homologacao.
// Opcionais:
//   TAXA_ABERTURAS       aberturas por segundo no patamar (padrão 5)
//   RAMPA / DURACAO      subida e patamar (padrão 2m / 5m)
//   MAX_VUS              teto de VUs do gerador (padrão 200)
//   LOGIN_POR_ITERACAO   "false" = login uma vez por VU; mede a abertura com
//                        o token já guardado no aparelho, que é o caso comum
//   CODIGO_VEICULO       pula a descoberta pelo /sga/veiculos
//   P95_MS, P95_LOGIN_MS, TAXA_ERRO_MAX   limites dos thresholds
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import {
  BASE_URL,
  autenticado,
  exigirCampos,
  exigirHomologacao,
  login,
  numeroEnv,
  observar,
  usuarioDoVu,
} from './lib/comum.js';

exigirCampos(['cpf', 'senha']);

const TAXA = numeroEnv('TAXA_ABERTURAS', 5);
const RAMPA = __ENV.RAMPA || '2m';
const DURACAO = __ENV.DURACAO || '5m';
const MAX_VUS = numeroEnv('MAX_VUS', 200);
const LOGIN_POR_ITERACAO =
  (__ENV.LOGIN_POR_ITERACAO || 'true').toLowerCase() !== 'false';
const CODIGO_VEICULO = __ENV.CODIGO_VEICULO || '';

const P95_MS = numeroEnv('P95_MS', 2000);
const P95_LOGIN_MS = numeroEnv('P95_LOGIN_MS', 1500);
const TAXA_ERRO_MAX = numeroEnv('TAXA_ERRO_MAX', 0.01);

export const options = {
  scenarios: {
    abertura: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(50, MAX_VUS),
      maxVUs: MAX_VUS,
      stages: [
        { target: TAXA, duration: RAMPA },
        { target: TAXA, duration: DURACAO },
        { target: 0, duration: '30s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: [`rate<${TAXA_ERRO_MAX}`],
    http_req_duration: [`p(95)<${P95_MS}`],
    'http_req_duration{name:login}': [`p(95)<${P95_LOGIN_MS}`],
    'http_req_duration{name:auth_me}': [`p(95)<${P95_MS}`],
    'http_req_duration{name:sga_associado}': [`p(95)<${P95_MS}`],
    'http_req_duration{name:sga_veiculos}': [`p(95)<${P95_MS}`],
    'http_req_duration{name:boleto_listar}': [`p(95)<${P95_MS}`],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  exigirHomologacao();
}

// Estado por VU (cada VU tem a sua cópia do módulo).
let tokenDoVu = null;

function ok(res) {
  return res.status >= 200 && res.status < 300;
}

export default function () {
  const usuario = usuarioDoVu();

  let token = tokenDoVu;
  if (LOGIN_POR_ITERACAO || !token) {
    token = login(usuario);
    tokenDoVu = token;
  }
  if (!token) {
    sleep(1);
    return;
  }

  group('abertura', () => {
    const me = observar(
      http.get(`${BASE_URL}/api/auth/me`, autenticado(token, 'auth_me')),
    );
    check(me, { 'auth/me 2xx': ok });
    if (me.status === 401) tokenDoVu = null;

    const associado = observar(
      http.get(
        `${BASE_URL}/api/sga/associado`,
        autenticado(token, 'sga_associado'),
      ),
    );
    check(associado, { 'sga/associado 2xx': ok });

    const veiculos = observar(
      http.get(
        `${BASE_URL}/api/sga/veiculos`,
        autenticado(token, 'sga_veiculos'),
      ),
    );
    check(veiculos, { 'sga/veiculos 2xx': ok });

    // O app lista os boletos do veículo escolhido; aqui, o primeiro da lista.
    let codigoVeiculo = CODIGO_VEICULO;
    if (!codigoVeiculo && ok(veiculos)) {
      try {
        const lista = veiculos.json();
        if (Array.isArray(lista) && lista.length > 0) {
          codigoVeiculo = lista[0].codigo_veiculo;
        }
      } catch (_e) {
        codigoVeiculo = '';
      }
    }

    const temVeiculo = check(codigoVeiculo, {
      'há veículo para consultar boletos': (c) => !!c,
    });
    if (!temVeiculo) return;

    const boletos = observar(
      http.post(
        `${BASE_URL}/api/sga/boleto/listar`,
        JSON.stringify({ codigo_veiculo: Number(codigoVeiculo) }),
        autenticado(token, 'boleto_listar'),
      ),
    );
    check(boletos, { 'sga/boleto/listar 2xx': ok });
  });
}
