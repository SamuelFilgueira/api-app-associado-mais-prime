import { Test, TestingModule } from '@nestjs/testing';
import { AppVersionService } from 'src/app-version/services/app-version.service';
import { AppVersionPolicyRepository } from 'src/app-version/repositories/app-version.repository';

describe('AppVersionService', () => {
  let service: AppVersionService;

  const repositoryMock = {
    getActivePolicy: jest.fn(),
    logValidationDecision: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppVersionService,
        {
          provide: AppVersionPolicyRepository,
          useValue: repositoryMock,
        },
      ],
    }).compile();

    service = module.get<AppVersionService>(AppVersionService);

    jest.clearAllMocks();
    repositoryMock.logValidationDecision.mockResolvedValue(undefined);
  });

  it('deve permitir quando nao existe politica ativa', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue(null);

    const result = await service.validateVersion({
      platform: 'android',
      appVersion: '1.1.7',
      runtimeVersion: '1.1.7',
      versionCode: 42,
    });

    expect(result.forceUpdate).toBe(false);
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: false, reason: 'no_active_policy' }),
    );
  });

  it('deve permitir quando force update estiver desabilitado', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 10,
      platform: 'android',
      minSupportedVersion: '1.1.8',
      minSupportedRuntimeVersion: '1.1.8',
      minSupportedVersionCode: 43,
      minSupportedBuildNumber: null,
      forceUpdateEnabled: false,
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

    const result = await service.validateVersion({
      platform: 'android',
      appVersion: '1.1.7',
      runtimeVersion: '1.1.7',
      versionCode: 42,
    });

    expect(result.forceUpdate).toBe(false);
    expect(result.minSupportedVersion).toBe('1.1.8');
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: false, reason: 'force_update_disabled' }),
    );
  });

  it('deve bloquear por appVersion abaixo do minimo', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 10,
      platform: 'android',
      minSupportedVersion: '1.1.8',
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

    const result = await service.validateVersion({
      platform: 'android',
      appVersion: '1.1.7',
      runtimeVersion: '1.1.7',
      versionCode: 42,
    });

    expect(result.forceUpdate).toBe(true);
    expect(result.title).toBe('Atualizacao obrigatoria');
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: 'app_version_below_minimum' }),
    );
  });

  it('deve bloquear por runtimeVersion abaixo do minimo', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 10,
      platform: 'android',
      minSupportedVersion: '1.1.7',
      minSupportedRuntimeVersion: '1.1.8',
      minSupportedVersionCode: 42,
      minSupportedBuildNumber: null,
      forceUpdateEnabled: true,
      title: 'Atualizacao obrigatoria',
      message: 'Atualize para continuar',
      storeUrl: null,
      effectiveFrom: new Date(),
      effectiveUntil: null,
      isActive: true,
      createdBy: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.validateVersion({
      platform: 'android',
      appVersion: '1.1.7',
      runtimeVersion: '1.1.7',
      versionCode: 42,
    });

    expect(result.forceUpdate).toBe(true);
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: 'runtime_version_below_minimum' }),
    );
  });

  it('deve bloquear por versionCode abaixo do minimo no android', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 10,
      platform: 'android',
      minSupportedVersion: '1.1.7',
      minSupportedRuntimeVersion: '1.1.7',
      minSupportedVersionCode: 43,
      minSupportedBuildNumber: null,
      forceUpdateEnabled: true,
      title: 'Atualizacao obrigatoria',
      message: 'Atualize para continuar',
      storeUrl: null,
      effectiveFrom: new Date(),
      effectiveUntil: null,
      isActive: true,
      createdBy: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.validateVersion({
      platform: 'android',
      appVersion: '1.1.7',
      runtimeVersion: '1.1.7',
      versionCode: 42,
    });

    expect(result.forceUpdate).toBe(true);
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: 'version_code_below_minimum' }),
    );
  });

  it('deve bloquear por buildNumber abaixo do minimo no ios', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 11,
      platform: 'ios',
      minSupportedVersion: '1.1.7',
      minSupportedRuntimeVersion: '1.1.7',
      minSupportedVersionCode: null,
      minSupportedBuildNumber: 8,
      forceUpdateEnabled: true,
      title: 'Atualizacao obrigatoria',
      message: 'Atualize para continuar',
      storeUrl: 'https://apps.apple.com/br/app/idSEU_APP_ID',
      effectiveFrom: new Date(),
      effectiveUntil: null,
      isActive: true,
      createdBy: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.validateVersion({
      platform: 'ios',
      appVersion: '1.1.7',
      runtimeVersion: '1.1.7',
      buildNumber: '7',
    });

    expect(result.forceUpdate).toBe(true);
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: 'build_number_below_minimum' }),
    );
  });

  it('deve bloquear quando appVersion recebida for invalida', async () => {
    repositoryMock.getActivePolicy.mockResolvedValue({
      id: 10,
      platform: 'android',
      minSupportedVersion: '1.1.7',
      minSupportedRuntimeVersion: null,
      minSupportedVersionCode: null,
      minSupportedBuildNumber: null,
      forceUpdateEnabled: true,
      title: 'Atualizacao obrigatoria',
      message: 'Atualize para continuar',
      storeUrl: null,
      effectiveFrom: new Date(),
      effectiveUntil: null,
      isActive: true,
      createdBy: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.validateVersion({
      platform: 'android',
      appVersion: 'abc',
    });

    expect(result.forceUpdate).toBe(true);
    expect(repositoryMock.logValidationDecision).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: true, reason: 'invalid_app_version' }),
    );
  });
});
