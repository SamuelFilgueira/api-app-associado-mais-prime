import { InternalServerErrorException } from '@nestjs/common';
import { HistoricoProviderResolverService } from 'src/rastreamento/services/historico-provider-resolver.service';
import {
  RastreamentoSoftruck,
  SoftruckVehicleNotFoundException,
} from 'src/rastreamento/softruck/services/rastreamento-softruck.service';
import {
  LogicaVeiculoInfo,
  TrajetosService,
} from 'src/rastreamento/logica/services/trajetos.service';
import {
  BaseOrigin,
  TokenResolverService,
} from 'src/shared/token-resolver.service';

const CHASSI = '9BD111060T5002156';
const BASE: BaseOrigin = 'MAIS_PRIME' as BaseOrigin;
const PUBLIC_KEY = 'public-key';

const vehicleData = {
  id: 'v-1',
  plate: 'KXC9D02',
  brandName: 'FIAT',
  modelName: 'UNO',
};
const deviceData = { vehicleId: 'v-1', deviceId: 'd-1' };

const veiculoLogica: LogicaVeiculoInfo = {
  id: 1325811,
  placa: 'KXC9D02',
  marca: 'FIAT',
  modelo: 'UNO',
};

describe('HistoricoProviderResolverService', () => {
  let softruck: { resolveVehicleAndDevice: jest.Mock };
  let trajetos: { buscarVeiculoPorChassi: jest.Mock };
  let tokenResolver: { resolveLogicaToken: jest.Mock };
  let resolver: HistoricoProviderResolverService;

  beforeEach(() => {
    softruck = { resolveVehicleAndDevice: jest.fn() };
    trajetos = { buscarVeiculoPorChassi: jest.fn() };
    tokenResolver = { resolveLogicaToken: jest.fn().mockReturnValue('token') };

    resolver = new HistoricoProviderResolverService(
      softruck as unknown as RastreamentoSoftruck,
      trajetos as unknown as TrajetosService,
      tokenResolver as unknown as TokenResolverService,
    );
  });

  it('resolve como softruck sem sondar a Lógica quando o veículo existe na Softruck', async () => {
    softruck.resolveVehicleAndDevice.mockResolvedValue({
      vehicleData,
      deviceData,
    });

    const resultado = await resolver.resolve(CHASSI, BASE, PUBLIC_KEY);

    expect(resultado).toEqual({
      provider: 'softruck',
      vehicleData,
      deviceData,
    });
    expect(trajetos.buscarVeiculoPorChassi).not.toHaveBeenCalled();
  });

  it('sonda a Lógica após SoftruckVehicleNotFoundException e resolve como logica', async () => {
    softruck.resolveVehicleAndDevice.mockRejectedValue(
      new SoftruckVehicleNotFoundException(),
    );
    trajetos.buscarVeiculoPorChassi.mockResolvedValue(veiculoLogica);

    const resultado = await resolver.resolve(CHASSI, BASE, PUBLIC_KEY);

    expect(resultado).toEqual({ provider: 'logica', veiculo: veiculoLogica });
    expect(trajetos.buscarVeiculoPorChassi).toHaveBeenCalledWith(
      CHASSI,
      BASE,
      'token',
    );
  });

  it('usa o cache logica na segunda chamada, sem nova tentativa Softruck', async () => {
    softruck.resolveVehicleAndDevice.mockRejectedValue(
      new SoftruckVehicleNotFoundException(),
    );
    trajetos.buscarVeiculoPorChassi.mockResolvedValue(veiculoLogica);

    await resolver.resolve(CHASSI, BASE, PUBLIC_KEY);
    const resultado = await resolver.resolve(CHASSI, BASE, PUBLIC_KEY);

    expect(resultado).toEqual({ provider: 'logica', veiculo: veiculoLogica });
    expect(softruck.resolveVehicleAndDevice).toHaveBeenCalledTimes(1);
    expect(trajetos.buscarVeiculoPorChassi).toHaveBeenCalledTimes(2);
  });

  it('invalida o cache logica quando o veículo sai da Lógica e volta a tentar a Softruck', async () => {
    softruck.resolveVehicleAndDevice.mockRejectedValue(
      new SoftruckVehicleNotFoundException(),
    );
    trajetos.buscarVeiculoPorChassi.mockResolvedValue(veiculoLogica);
    await resolver.resolve(CHASSI, BASE, PUBLIC_KEY);

    // Veículo saiu da Lógica e agora existe na Softruck
    trajetos.buscarVeiculoPorChassi.mockResolvedValue(null);
    softruck.resolveVehicleAndDevice.mockResolvedValue({
      vehicleData,
      deviceData,
    });

    const resultado = await resolver.resolve(CHASSI, BASE, PUBLIC_KEY);

    expect(resultado).toEqual({
      provider: 'softruck',
      vehicleData,
      deviceData,
    });
    expect(softruck.resolveVehicleAndDevice).toHaveBeenCalledTimes(2);
  });

  it('propaga erro Softruck que não seja VehicleNotFound, sem sondar a Lógica', async () => {
    const erroApi = new InternalServerErrorException(
      'Falha no login Softruck (500): Erro desconhecido',
    );
    softruck.resolveVehicleAndDevice.mockRejectedValue(erroApi);

    await expect(resolver.resolve(CHASSI, BASE, PUBLIC_KEY)).rejects.toBe(
      erroApi,
    );
    expect(trajetos.buscarVeiculoPorChassi).not.toHaveBeenCalled();
  });

  it('relança o erro Softruck original quando o chassi não existe em nenhum provider', async () => {
    const erroSoftruck = new SoftruckVehicleNotFoundException();
    softruck.resolveVehicleAndDevice.mockRejectedValue(erroSoftruck);
    trajetos.buscarVeiculoPorChassi.mockResolvedValue(null);

    await expect(resolver.resolve(CHASSI, BASE, PUBLIC_KEY)).rejects.toBe(
      erroSoftruck,
    );
  });

  it('relança o erro Softruck original quando a sonda na Lógica falha', async () => {
    const erroSoftruck = new SoftruckVehicleNotFoundException();
    softruck.resolveVehicleAndDevice.mockRejectedValue(erroSoftruck);
    trajetos.buscarVeiculoPorChassi.mockRejectedValue(
      new Error('Lógica fora do ar'),
    );

    await expect(resolver.resolve(CHASSI, BASE, PUBLIC_KEY)).rejects.toBe(
      erroSoftruck,
    );
  });
});
