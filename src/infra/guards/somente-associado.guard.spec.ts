import {
  Controller,
  Get,
  INestApplication,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTENTICACAO_DE_TESTE,
  bearer,
  clienteHttp,
  prepararSegredoDeTeste,
  tokenDoApp,
  tokenDoPainel,
} from 'src/infra/auth/testing/jwt-de-teste';
import { JwtAuthGuard } from 'src/infra/guards/jwt-auth.guard';
import { SomenteAssociadoGuard } from 'src/infra/guards/somente-associado.guard';

@Controller('so-app')
@UseGuards(JwtAuthGuard, SomenteAssociadoGuard)
class ControllerSoDoApp {
  @Get('boletos')
  boletos(@Req() req: { user: { userId: number } }) {
    return { deQuem: req.user.userId };
  }
}

/**
 * App e painel usam o mesmo segredo e ids numéricos: sem este guard, um
 * token do painel com id 7 lia os dados do associado 7.
 */
describe('SomenteAssociadoGuard', () => {
  let app: INestApplication;

  beforeAll(async () => {
    prepararSegredoDeTeste();
    const modulo = await Test.createTestingModule({
      imports: [...AUTENTICACAO_DE_TESTE.imports],
      controllers: [ControllerSoDoApp],
      providers: [...AUTENTICACAO_DE_TESTE.providers],
    }).compile();
    app = modulo.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('associado passa', async () => {
    const resposta = await clienteHttp(app)
      .get('/so-app/boletos')
      .set(bearer(tokenDoApp({ id: 7, cpf: '11122233344' })))
      .expect(200);
    expect(resposta.body).toEqual({ deQuem: 7 });
  });

  it('ADMIN legado do app (role ADMIN, sem perfil do painel) é associado e passa', async () => {
    await clienteHttp(app)
      .get('/so-app/boletos')
      .set(bearer(tokenDoApp({ id: 2, cpf: '11122233344', role: 'ADMIN' })))
      .expect(200);
  });

  it('token do painel com o mesmo id numérico de um associado → 403', async () => {
    await clienteHttp(app)
      .get('/so-app/boletos')
      .set(bearer(tokenDoPainel({ id: 7, adminRole: 'ADMIN' })))
      .expect(403);
  });

  it('sem token → 401 (quem responde é o JwtAuthGuard)', async () => {
    await clienteHttp(app).get('/so-app/boletos').expect(401);
  });
});
