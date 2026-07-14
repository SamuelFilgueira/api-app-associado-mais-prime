import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { AppVersionPolicyRepository } from './app-version.repository';

describe('AppVersionController (integration)', () => {
  let app: INestApplication;

  const repositoryMock = {
    getActivePolicy: jest.fn(),
    logValidationDecision: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppVersionController],
      providers: [
        AppVersionService,
        { provide: AppVersionPolicyRepository, useValue: repositoryMock },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repositoryMock.logValidationDecision.mockResolvedValue(undefined);
  });

  it('POST /app-version/validate deve retornar forceUpdate false quando atender minimo', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 20,
      platform: 'android',
      minSupportedVersion: '1.1.7',
      minSupportedRuntimeVersion: '1.1.7',
      minSupportedVersionCode: 42,
      minSupportedBuildNumber: null,
      forceUpdateEnabled: true,
      title: 'Atualizacao obrigatoria',
      message: 'Atualize para continuar',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.maisprime.vantagens',
      effectiveFrom: new Date(),
      effectiveUntil: null,
      isActive: true,
      createdBy: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app.getHttpServer())
      .post('/app-version/validate')
      .send({
        platform: 'android',
        appVersion: '1.1.7',
        runtimeVersion: '1.1.7',
        versionCode: 42,
      })
      .expect(200);

    expect(response.body).toMatchObject({
      forceUpdate: false,
      title: '',
      message: '',
      minSupportedVersion: '1.1.7',
      minSupportedRuntimeVersion: '1.1.7',
    });
  });

  it('POST /app-version/validate deve retornar forceUpdate true quando versao for menor', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 21,
      platform: 'android',
      minSupportedVersion: '1.1.8',
      minSupportedRuntimeVersion: '1.1.8',
      minSupportedVersionCode: 43,
      minSupportedBuildNumber: null,
      forceUpdateEnabled: true,
      title: 'Atualizacao obrigatoria',
      message: 'Uma nova versao do app esta disponivel. Atualize para continuar.',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.maisprime.vantagens',
      effectiveFrom: new Date(),
      effectiveUntil: null,
      isActive: true,
      createdBy: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(app.getHttpServer())
      .post('/app-version/validate')
      .send({
        platform: 'android',
        appVersion: '1.1.7',
        runtimeVersion: '1.1.7',
        versionCode: 42,
      })
      .expect(200);

    expect(response.body).toMatchObject({
      forceUpdate: true,
      title: 'Atualizacao obrigatoria',
      message: 'Uma nova versao do app esta disponivel. Atualize para continuar.',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.maisprime.vantagens',
      minSupportedVersion: '1.1.8',
      minSupportedRuntimeVersion: '1.1.8',
    });
  });

  it('POST /app-version/validate deve validar payload invalido', async () => {
    await request(app.getHttpServer())
      .post('/app-version/validate')
      .send({
        platform: 'web',
        appVersion: '1.1.7',
      })
      .expect(400);
  });
});
