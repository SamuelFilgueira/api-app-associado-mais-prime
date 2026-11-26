import { AppModule } from 'src/app.module';
import { inventariarRotas } from 'src/infra/auth/testing/inventario-de-rotas';

/**
 * Rotas que podem ser chamadas SEM nenhum guard, e por quê. Qualquer rota
 * nova sem guard precisa entrar aqui de propósito — é o que faltava quando
 * `GET /associado/:id`, `POST /auth/register` e `POST
 * /rastreamento/renovar-token` ficaram abertas na internet sem ninguém notar.
 */
const ROTAS_PUBLICAS: Record<string, string> = {
  'GET /': 'página raiz (texto fixo)',
  'GET /health': 'sonda (formato antigo)',
  'GET /health/live': 'sonda do container',
  'GET /health/ready': 'sonda do proxy e do deploy',
  'GET /metrics':
    'protegida no próprio handler: rede interna ou Bearer METRICS_TOKEN',
  'POST /auth/login': 'login do app (limitado por tentativas)',
  'POST /admin-panel/auth/login': 'login do painel (limitado por tentativas)',
  'POST /auth/reset-password':
    'recuperação de senha por CPF (limitada por CPF e IP)',
  'POST /associado/primeiro-acesso':
    'primeiro acesso só com o CPF — regra da associação (limitado por CPF e IP)',
  'POST /auth/test-ses-email':
    'diagnóstico de e-mail; só responde com ENABLE_TEST_ENDPOINTS=true',
  'POST /app-version/validate': 'gate de versão mínima, chamado antes do login',
  'GET /expo-updates/manifest': 'protocolo de atualização OTA do app',
  'GET /expo-updates/assets': 'arquivos do update OTA (públicos e imutáveis)',
};

describe('Inventário de rotas — toda rota tem guard ou é pública de propósito', () => {
  const rotas = inventariarRotas(AppModule);

  it('enxerga a aplicação inteira', () => {
    // Se o inventário quebrar (mudança nos metadados do Nest), ele voltaria
    // uma lista vazia e o teste seguinte passaria por engano.
    expect(rotas.length).toBeGreaterThan(200);
    expect(rotas.map((r) => r.rota)).toEqual(
      expect.arrayContaining([
        'POST /auth/login',
        'GET /associado/:id',
        'POST /rastreamento',
        'GET /sga/associado',
      ]),
    );
  });

  it('nenhuma rota sem guard fora da lista de rotas públicas', () => {
    const abertas = rotas
      .filter((r) => r.guards.length === 0)
      .map((r) => r.rota)
      .filter((rota) => !(rota in ROTAS_PUBLICAS));

    expect(abertas).toEqual([]);
  });

  it('a lista de rotas públicas não tem entrada que não existe mais', () => {
    const existentes = new Set(rotas.map((r) => r.rota));
    const sobrando = Object.keys(ROTAS_PUBLICAS).filter(
      (rota) => !existentes.has(rota),
    );

    expect(sobrando).toEqual([]);
  });

  it('rota pública não ganhou guard sem sair da lista (lista desatualizada)', () => {
    const comGuard = rotas
      .filter((r) => r.rota in ROTAS_PUBLICAS && r.guards.length > 0)
      .map((r) => r.rota);

    expect(comGuard).toEqual([]);
  });

  it.each([
    ['GET /associado/:id', 'JwtAuthGuard'],
    ['GET /associado/cpf', 'JwtAuthGuard'],
    ['PATCH /associado/:id/password', 'JwtAuthGuard'],
    ['POST /auth/register', 'AdminTokenGuard'],
    ['POST /rastreamento/renovar-token', 'AdminTokenGuard'],
    ['POST /notifications/test', 'AdminRoleGuard'],
    ['POST /notifications/queue-test', 'AdminRoleGuard'],
    ['GET /rastreamento/ancora-status', 'JwtAuthGuard'],
    ['GET /rastreamento/ignicao-status', 'JwtAuthGuard'],
    ['GET /sga/associado', 'SomenteAssociadoGuard'],
    ['GET /admin/filas', 'AdminPanelRoleGuard'],
  ])('%s exige %s', (rota, guard) => {
    const encontrada = rotas.find((r) => r.rota === rota);

    expect(encontrada).toBeDefined();
    expect(encontrada!.guards).toContain(guard);
  });
});
