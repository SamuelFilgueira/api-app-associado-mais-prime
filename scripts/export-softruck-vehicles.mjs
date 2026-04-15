import axios from 'axios';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_ORIGIN = 'MAIS_PRIME';
const REQUEST_TIMEOUT = 15_000;
const INPUT_FILE = path.resolve(__dirname, '../src/dadosjson/dados.json');
const OUTPUT_FILE = path.resolve(
  __dirname,
  '../src/dadosjson/dados-softruck.json',
);

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.resolve(__dirname, '../.env'));
  } catch {
    // Ignora ausência da .env; o script ainda pode rodar com vars já exportadas.
  }
}

let softruckToken = process.env.SOFTRUCK_TOKEN;
const publicKeyCandidates = buildPublicKeyCandidates();
let currentPublicKeyIndex = 0;

function resolveRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not configured`);
  }
  return value;
}

function buildPublicKeyCandidates() {
  const candidateEnvNames = [
    'SOFTRUCK_PUBLIC_KEY_OVERRIDE',
    'PUBLIC_KEY_SOFTRUCK',
    'PUBLIC_KEY_SOFTRUCK_RS',
  ];

  return candidateEnvNames
    .map((envName) => {
      const value = process.env[envName]?.trim();
      return value ? { envName, value } : null;
    })
    .filter(Boolean)
    .filter(
      (candidate, index, array) =>
        array.findIndex((item) => item.value === candidate.value) === index,
    );
}

function getCurrentPublicKeyCandidate() {
  return publicKeyCandidates[currentPublicKeyIndex] ?? null;
}

function isInvalidPublicKeyError(error) {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const message = error.response?.data?.error?.message;
  return typeof message === 'string' && message === 'Public key does not exist';
}

function buildSoftruckUrl(resourcePath) {
  const baseUrl = resolveRequiredEnv('SOFTRUCK_API_BASE_URL');
  const normalizedBaseUrl = baseUrl.endsWith('/')
    ? baseUrl.slice(0, -1)
    : baseUrl;

  return `${normalizedBaseUrl}/${resourcePath.replace(/^\//, '')}`;
}

function getRequestHeaders(publicKey, overrideToken) {
  const token = overrideToken ?? softruckToken;

  if (!token) {
    throw new Error(`Token Softruck não disponível para base ${BASE_ORIGIN}`);
  }

  return {
    Authorization: `Bearer ${token}`,
    'public-key': publicKey,
  };
}

function isAuthError(error) {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  return status === 401 || status === 403;
}

function formatError(error) {
  if (axios.isAxiosError(error)) {
    return [
      `HTTP ${error.response?.status ?? 'N/A'}`,
      `URL: ${error.config?.url ?? 'N/A'}`,
      `Body: ${JSON.stringify(error.response?.data ?? null)}`,
    ].join(' | ');
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function autenticarSoftruck(publicKey) {
  const username = resolveRequiredEnv('USERNAME_SOFTRUCK');
  const password = resolveRequiredEnv('PASSWORD_SOFTRUCK');

  const response = await axios.post(
    buildSoftruckUrl('/auth/login'),
    { username, password },
    {
      headers: {
        'public-key': publicKey,
      },
      timeout: REQUEST_TIMEOUT,
    },
  );

  const token = response.data?.data?.token;

  if (!token) {
    throw new Error('Token não retornado no login da Softruck');
  }

  softruckToken = token;
}

async function executarComReautenticacao(request, publicKey) {
  try {
    return await request();
  } catch (error) {
    if (isInvalidPublicKeyError(error)) {
      throw error;
    }

    if (!isAuthError(error)) {
      throw error;
    }

    console.warn(
      `[${BASE_ORIGIN}] Token Softruck expirado/inválido. Realizando novo login.`,
    );

    await autenticarSoftruck(publicKey);
    return request();
  }
}

async function obterVehicleId(chassi, publicKey) {
  const response = await executarComReautenticacao(
    () =>
      axios.get(buildSoftruckUrl('/vehicles'), {
        params: {
          search: chassi,
        },
        headers: getRequestHeaders(publicKey),
        timeout: REQUEST_TIMEOUT,
      }),
    publicKey,
  );

  if (!response.data?.data || response.data.data.length === 0) {
    throw new Error('Veículo não encontrado na base Softruck');
  }

  const vehicleData = response.data.data[0];

  return {
    id: vehicleData.id,
    plate: vehicleData.attributes.plate,
    brandName: vehicleData.attributes.brand_name,
    modelName: vehicleData.attributes.model_name,
  };
}

async function obterVehicleIdComFallback(chassi) {
  let lastError;

  for (
    let candidateIndex = currentPublicKeyIndex;
    candidateIndex < publicKeyCandidates.length;
    candidateIndex += 1
  ) {
    currentPublicKeyIndex = candidateIndex;
    const candidate = getCurrentPublicKeyCandidate();

    try {
      return await obterVehicleId(chassi, candidate.value);
    } catch (error) {
      lastError = error;

      if (!isInvalidPublicKeyError(error)) {
        throw error;
      }

      softruckToken = undefined;

      const nextCandidate = publicKeyCandidates[candidateIndex + 1];
      if (!nextCandidate) {
        throw error;
      }

      console.warn(
        `[${BASE_ORIGIN}] Chave ${candidate.envName} rejeitada pela Softruck. Tentando ${nextCandidate.envName}.`,
      );
    }
  }

  throw lastError;
}

async function readInputFile() {
  const content = await readFile(INPUT_FILE, 'utf8');
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error('O arquivo de entrada precisa conter um array JSON');
  }

  return data;
}

async function main() {
  const inputRows = await readInputFile();
  const successRows = [];
  const failedRows = [];

  if (publicKeyCandidates.length === 0) {
    throw new Error(
      'Nenhuma public key Softruck foi configurada (PUBLIC_KEY_SOFTRUCK, PUBLIC_KEY_SOFTRUCK_RS, SOFTRUCK_PUBLIC_KEY_OVERRIDE)',
    );
  }

  const initialCandidate = getCurrentPublicKeyCandidate();
  console.log(
    `[${BASE_ORIGIN}] Iniciando exportação com public key ${initialCandidate.envName}.`,
  );

  if (!softruckToken) {
    await autenticarSoftruck(initialCandidate.value);
  }

  for (const [index, row] of inputRows.entries()) {
    const chassi = typeof row?.Chassi === 'string' ? row.Chassi.trim() : '';

    if (!chassi) {
      failedRows.push({
        index: index + 1,
        reason: 'Campo Chassi ausente ou inválido',
      });
      console.error(`[${index + 1}/${inputRows.length}] ERRO chassi inválido`);
      continue;
    }

    try {
      const vehicle = await obterVehicleIdComFallback(chassi);
      successRows.push({
        ...row,
        softruck: vehicle,
      });
      console.log(
        `[${index + 1}/${inputRows.length}] OK ${chassi} -> ${vehicle.id}`,
      );
    } catch (error) {
      failedRows.push({
        index: index + 1,
        chassi,
        reason: formatError(error),
      });
      console.error(
        `[${index + 1}/${inputRows.length}] FALHA ${chassi} -> ${formatError(error)}`,
      );
    }
  }

  await writeFile(`${OUTPUT_FILE}`, `${JSON.stringify(successRows, null, 2)}\n`);

  console.log('');
  console.log(`Base: ${BASE_ORIGIN}`);
  console.log(`Entrada: ${INPUT_FILE}`);
  console.log(`Saída: ${OUTPUT_FILE}`);
  console.log(`Public key final: ${getCurrentPublicKeyCandidate()?.envName ?? 'nenhuma'}`);
  console.log(`Sucessos: ${successRows.length}`);
  console.log(`Falhas: ${failedRows.length}`);
}

main().catch((error) => {
  console.error(`Erro ao exportar dados Softruck: ${formatError(error)}`);
  process.exitCode = 1;
});