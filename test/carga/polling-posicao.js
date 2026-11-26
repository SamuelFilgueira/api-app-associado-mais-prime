// Linha de base: tela de rastreamento aberta.
//
// Cada VU é um aparelho com o mapa aberto, consultando a posição a cada 5 s:
//   POST /api/rastreamento   { cnpj, chassi }
// (a API consulta os provedores em paralelo e devolve a posição mais recente)
//
// O login é feito uma vez, no setup — aqui o que se mede é o polling.
//
// Envs: BASE_URL, CPF, SENHA, CHASSI, CNPJ (ou USUARIOS_ARQUIVO),
//       AMBIENTE=homologacao.
// Opcionais:
//   VUS             aparelhos simultâneos no patamar (padrão 50)
//   INTERVALO_SEG   intervalo entre consultas de cada VU (padrão 5)
//   RAMPA / DURACAO subida e patamar (padrão 2m / 10m)
//   P95_MS, TAXA_ERRO_MAX   limites dos thresholds
//
// Com um único usuário, todos os VUs consultam o mesmo chassi: a API responde
// do cache e a política `posicao` (12/min por usuário e chassi) passa a marcar
// "observado". Para uma medida fiel use USUARIOS_ARQUIVO com um veículo por VU.
import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  BASE_URL,
  USUARIOS,
  autenticado,
  exigirCampos,
  exigirHomologacao,
  loginDeTodos,
  numeroEnv,
  observar,
} from './lib/comum.js';

exigirCampos(['cpf', 'senha', 'chassi', 'cnpj']);

const VUS = numeroEnv('VUS', 50);
const INTERVALO_SEG = numeroEnv('INTERVALO_SEG', 5);
const RAMPA = __ENV.RAMPA || '2m';
const DURACAO = __ENV.DURACAO || '10m';

const P95_MS = numeroEnv('P95_MS', 1500);
const TAXA_ERRO_MAX = numeroEnv('TAXA_ERRO_MAX', 0.01);

export const options = {
  setupTimeout: '5m',
  scenarios: {
    polling: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: VUS, duration: RAMPA },
        { target: VUS, duration: DURACAO },
        { target: 0, duration: '30s' },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    http_req_failed: [`rate<${TAXA_ERRO_MAX}`],
    'http_req_duration{name:rastreamento}': [`p(95)<${P95_MS}`],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  exigirHomologacao();
  return { tokens: loginDeTodos() };
}

export default function (dados) {
  const indice = (__VU - 1) % USUARIOS.length;
  const usuario = USUARIOS[indice];
  const token = dados.tokens[indice];

  // Espalha o primeiro disparo: sem isso todos os VUs batem no mesmo segundo
  // e o teste mede rajada, não polling.
  if (__ITER === 0) sleep(Math.random() * INTERVALO_SEG);

  const inicio = Date.now();
  const res = observar(
    http.post(
      `${BASE_URL}/api/rastreamento`,
      JSON.stringify({ cnpj: usuario.cnpj, chassi: usuario.chassi }),
      autenticado(token, 'rastreamento'),
    ),
  );
  check(res, {
    'rastreamento 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  // Mantém o período de 5 s descontando o tempo da própria resposta.
  const gastoSeg = (Date.now() - inicio) / 1000;
  sleep(Math.max(0, INTERVALO_SEG - gastoSeg));
}
