#!/usr/bin/env node
/*
 * Proxy de demonstração do Associado da Sorte — SÓ PARA AMBIENTE LOCAL.
 *
 * Os associados criados por `npm run sorte:seed-demo` não existem no SGA, então
 * o app os barra no login (`/associado/verificar-situacao`) e fica sem veículo
 * (`/sga/veiculos`). Este proxy repassa tudo para a API local e responde por
 * conta própria, apenas para os CPFs de demonstração:
 *   - GET /api/associado/verificar-situacao/{cpf}  → liberado;
 *   - GET /api/sga/veiculos                         → um veículo fictício ATIVO;
 *   - GET /api/sga/associado                        → associado fictício com o veículo
 *     (equivalente ao `associado/buscar/{cpf}` do SGA);
 *   - GET /api/sga/beneficios-veiculo/{codigo}      → produtos do veículo, com o
 *     "ASSOCIADO DA SORTE" (3677) ATIVO (equivalente ao `produto-vinculado-veiculo`).
 * Associados reais passam direto, sem alteração.
 *
 * Inscrição na promoção: o BACKEND consulta o SGA por conta própria (não passa
 * por este proxy). Para os CPFs de demonstração ela vem da marcação MANUAL
 * gravada pelo seed (101–103 inscritos, 104–106 não), que prevalece sem
 * chamar o SGA.
 *
 * Uso:
 *   node scripts/sorte-proxy-demo.mjs
 *   # no app: EXPO_PUBLIC_API_BASE_URL=http://<ip-da-maquina>:3999/api
 *
 * Variáveis: PORTA (padrão 3999), API_ALVO (padrão http://127.0.0.1:3001).
 */
import http from 'node:http';

const PORTA = Number(process.env.PORTA || 3999);
const ALVO = new URL(process.env.API_ALVO || 'http://127.0.0.1:3001');
const CPF_DEMO = /^90000000[12]0[1-6]$/;

if (!['127.0.0.1', 'localhost'].includes(ALVO.hostname)) {
  console.error(
    'API_ALVO precisa ser local: este proxy é só para demonstração.',
  );
  process.exit(1);
}

const VEICULO_DEMO = [
  {
    codigo_veiculo: '999001',
    placa: 'DEM0A01',
    chassi: '9BWZZZ377VT004251',
    valor_fixo: 0,
    codigo_situacao: '1',
    valor_fipe: 50000,
    situacao: 'ATIVO',
    descricao_modelo: 'DEMO HATCH 1.0',
    codigo_modelo: '1',
  },
];

/** Produtos do veículo de demonstração (formato de produto-vinculado-veiculo). */
const PRODUTOS_DEMO = {
  codigo_veiculo: '999001',
  valor_fixo: 0,
  codigo_cota: '1',
  valor_fipe: 50000,
  produtos: [
    {
      codigo_produto: '3677',
      descricao: 'ASSOCIADO DA SORTE',
      descricao_boleto: 'ASSOCIADO DA SORTE',
      valor: '0.00',
      codigo_classificacao_produto: '1',
      exibir_mcv: 'S',
      exibir_boleto: 'S',
      formato_cobranca: 'VALOR FIXO',
      situacao: 'ATIVO',
    },
  ],
  produtos_adicionais: [],
};

/** Lê o CPF do JWT sem validar a assinatura (a API continua validando o resto). */
function cpfDoToken(req) {
  try {
    const token = String(req.headers.authorization || '').split(' ')[1];
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    return String(payload.cpf || '');
  } catch {
    return '';
  }
}

function responderJson(res, corpo) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

http
  .createServer((req, res) => {
    if (req.method === 'GET') {
      const situacao = req.url.match(
        /^\/api\/associado\/verificar-situacao\/(\d+)/,
      );
      if (situacao && CPF_DEMO.test(situacao[1])) {
        console.log('[demo] situação liberada para associado de demonstração');
        return responderJson(res, { liberado: true });
      }
      const cpf = cpfDoToken(req);
      if (/^\/api\/sga\/veiculos(\?|$)/.test(req.url) && CPF_DEMO.test(cpf)) {
        console.log('[demo] veículo fictício para associado de demonstração');
        return responderJson(res, VEICULO_DEMO);
      }
      if (/^\/api\/sga\/associado(\?|$)/.test(req.url) && CPF_DEMO.test(cpf)) {
        console.log('[demo] associado fictício para associado de demonstração');
        return responderJson(res, {
          cpf,
          nome: 'Associado de demonstração',
          situacao: 'ATIVO',
          veiculos: VEICULO_DEMO,
        });
      }
      if (
        /^\/api\/sga\/beneficios-veiculo\/999001(\?|$)/.test(req.url) &&
        CPF_DEMO.test(cpf)
      ) {
        console.log('[demo] produtos do veículo de demonstração');
        return responderJson(res, PRODUTOS_DEMO);
      }
    }

    const repasse = http.request(
      {
        host: ALVO.hostname,
        port: ALVO.port || 80,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: ALVO.host },
      },
      (resposta) => {
        if (req.url.includes('associado-sorte')) {
          console.log(req.method, req.url.split('?')[0], resposta.statusCode);
        }
        res.writeHead(resposta.statusCode, resposta.headers);
        resposta.pipe(res);
      },
    );
    repasse.on('error', (erro) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          statusCode: 502,
          message: `API local fora do ar: ${erro.message}`,
        }),
      );
    });
    req.pipe(repasse);
  })
  .listen(PORTA, '0.0.0.0', () => {
    console.log(
      `Proxy de demonstração em http://0.0.0.0:${PORTA} -> ${ALVO.origin}`,
    );
  });
