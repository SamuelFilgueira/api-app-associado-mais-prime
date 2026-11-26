// Linha de base: PDFs simultâneos — rampa em degraus para achar o teto.
//
// Sobe um PDF simultâneo por degrau (1, 2, 3 ... MAX_SIMULTANEOS) e segura
// cada degrau por DEGRAU. O teto é o último degrau em que não aparece 504 nem
// erro e o p95 fica dentro do prazo; o teste se interrompe sozinho quando os
// thresholds estouram.
//
// Rota (PDF_PROVEDOR):
//   softruck (padrão)   GET /api/rastreamento/historico/softruck/pdf      ?chassi&dataInicial&dataFinal
//   m7                  GET /api/rastreamento/historico/m7/pdf            ?cnpj&chassi&dataInicial&dataFinal
//   m7-v2               GET /api/rastreamento/historico/m7/pdf-v2
//   m7-contestacao      GET /api/rastreamento/historico/m7/pdf-contestacao      (período máx. 5 dias)
//   m7-contestacao-v2   GET /api/rastreamento/historico/m7/pdf-contestacao-v2   (período máx. 5 dias, streaming)
//   logica              GET /api/rastreamento/logica/trajetos/relatorio   ?chassi&dataInicial&dataFinal
//
// Envs: BASE_URL, CPF, SENHA, CHASSI, CNPJ (ou USUARIOS_ARQUIVO),
//       AMBIENTE=homologacao.
// Opcionais:
//   PDF_PROVEDOR      ver tabela acima
//   MAX_SIMULTANEOS   último degrau da rampa (padrão 8)
//   DEGRAU            duração de cada degrau (padrão 2m)
//   DATA_INICIAL / DATA_FINAL   YYYY-MM-DD (padrão: últimos 7 dias; 3 nas
//                     rotas de contestação). Máximo aceito pela API: 31 dias.
//   PAUSA_MIN_SEG     tempo mínimo de cada iteração (padrão 20)
//   P95_PDF_MS, TAXA_ERRO_MAX   limites dos thresholds
//
// IMPORTANTE — um usuário por VU. A política `relatorio` da API permite UM
// PDF por vez e 3 por minuto POR USUÁRIO, e ela é aplicada (não só observada).
// Com menos usuários que MAX_SIMULTANEOS o teste mede o 429, não o Chromium:
// use USUARIOS_ARQUIVO, ou desligue o limite na homologação
// (RATE_LIMIT_ENABLED=false). A pausa mínima de 20 s respeita os 3 por minuto.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  USUARIOS,
  autenticado,
  dataRelativa,
  exigirCampos,
  exigirHomologacao,
  loginDeTodos,
  numeroEnv,
  observar,
} from './lib/comum.js';

const ROTAS = {
  softruck: { caminho: '/api/rastreamento/historico/softruck/pdf', cnpj: false, dias: 7 },
  m7: { caminho: '/api/rastreamento/historico/m7/pdf', cnpj: true, dias: 7 },
  'm7-v2': { caminho: '/api/rastreamento/historico/m7/pdf-v2', cnpj: true, dias: 7 },
  'm7-contestacao': { caminho: '/api/rastreamento/historico/m7/pdf-contestacao', cnpj: true, dias: 3 },
  'm7-contestacao-v2': { caminho: '/api/rastreamento/historico/m7/pdf-contestacao-v2', cnpj: true, dias: 3 },
  logica: { caminho: '/api/rastreamento/logica/trajetos/relatorio', cnpj: false, dias: 7 },
};

const PROVEDOR = (__ENV.PDF_PROVEDOR || 'softruck').toLowerCase();
const ROTA = ROTAS[PROVEDOR];
if (!ROTA) {
  throw new Error(
    `PDF_PROVEDOR inválido: "${PROVEDOR}". Use um de: ${Object.keys(ROTAS).join(', ')}.`,
  );
}

exigirCampos(ROTA.cnpj ? ['cpf', 'senha', 'chassi', 'cnpj'] : ['cpf', 'senha', 'chassi']);

const MAX_SIMULTANEOS = Math.max(1, Math.trunc(numeroEnv('MAX_SIMULTANEOS', 8)));
const DEGRAU = __ENV.DEGRAU || '2m';
const DATA_FINAL = __ENV.DATA_FINAL || dataRelativa(-1);
const DATA_INICIAL = __ENV.DATA_INICIAL || dataRelativa(-ROTA.dias);
const PAUSA_MIN_SEG = numeroEnv('PAUSA_MIN_SEG', 20);

const P95_PDF_MS = numeroEnv('P95_PDF_MS', 60000);
const TAXA_ERRO_MAX = numeroEnv('TAXA_ERRO_MAX', 0.05);

// Escada: 10 s para subir um VU, DEGRAU segurando.
const estagios = [];
for (let n = 1; n <= MAX_SIMULTANEOS; n++) {
  estagios.push({ target: n, duration: '10s' });
  estagios.push({ target: n, duration: DEGRAU });
}

export const options = {
  setupTimeout: '5m',
  scenarios: {
    pdfs: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: estagios,
      // Deixa terminar o PDF em andamento (o Nginx espera até 180 s).
      gracefulRampDown: '200s',
      gracefulStop: '200s',
    },
  },
  thresholds: {
    // Estourou = passou do teto: interrompe em vez de continuar subindo.
    'http_req_failed{name:pdf}': [
      { threshold: `rate<${TAXA_ERRO_MAX}`, abortOnFail: true, delayAbortEval: '1m' },
    ],
    'http_req_duration{name:pdf}': [
      { threshold: `p(95)<${P95_PDF_MS}`, abortOnFail: true, delayAbortEval: '1m' },
    ],
  },
};

// Contagem por desfecho, para ler o teto direto no resumo.
const pdfOk = new Counter('pdf_ok');
const pdfPrazoEstourado = new Counter('pdf_504_prazo');
const pdfOutrosErros = new Counter('pdf_outros_erros');
const pdfDuracaoOk = new Trend('pdf_duracao_ok', true);

export function setup() {
  exigirHomologacao();
  if (USUARIOS.length < MAX_SIMULTANEOS) {
    console.warn(
      `Há ${USUARIOS.length} usuário(s) para ${MAX_SIMULTANEOS} PDFs simultâneos: ` +
        'a política "relatorio" (1 PDF por vez e 3/min por usuário) vai responder 429. ' +
        'Use USUARIOS_ARQUIVO ou RATE_LIMIT_ENABLED=false na homologação.',
    );
  }
  console.log(
    `PDF: ${ROTA.caminho} | período ${DATA_INICIAL} a ${DATA_FINAL} | até ${MAX_SIMULTANEOS} simultâneos`,
  );
  return { tokens: loginDeTodos() };
}

function montarUrl(usuario) {
  const parametros = [
    `chassi=${encodeURIComponent(usuario.chassi)}`,
    `dataInicial=${DATA_INICIAL}`,
    `dataFinal=${DATA_FINAL}`,
  ];
  if (ROTA.cnpj) parametros.unshift(`cnpj=${encodeURIComponent(usuario.cnpj)}`);
  return `${BASE_URL}${ROTA.caminho}?${parametros.join('&')}`;
}

export default function (dados) {
  const indice = (__VU - 1) % USUARIOS.length;
  const usuario = USUARIOS[indice];
  const token = dados.tokens[indice];

  const inicio = Date.now();
  const res = observar(
    http.get(
      montarUrl(usuario),
      autenticado(token, 'pdf', {
        // Acima do proxy_read_timeout do Nginx (180 s) e do PDF_PRAZO_MS da API.
        timeout: '200s',
        // O conteúdo do PDF não interessa; não guardar poupa a memória do gerador.
        responseType: 'none',
      }),
    ),
  );

  const tipo = String(res.headers['Content-Type'] || '');
  const sucesso = check(res, {
    'pdf: status 200': (r) => r.status === 200,
    'pdf: content-type application/pdf': () => tipo.indexOf('application/pdf') !== -1,
  });

  if (sucesso) {
    pdfOk.add(1);
    pdfDuracaoOk.add(res.timings.duration);
  } else if (res.status === 504) {
    pdfPrazoEstourado.add(1);
  } else if (res.status !== 429) {
    pdfOutrosErros.add(1);
  }

  const gastoSeg = (Date.now() - inicio) / 1000;
  sleep(Math.max(1, PAUSA_MIN_SEG - gastoSeg));
}
