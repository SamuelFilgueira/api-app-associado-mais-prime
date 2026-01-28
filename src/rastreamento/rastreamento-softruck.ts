import { InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';

export interface UltimaPosicaoSoftruckResponse {
  date: string;
  ign?: boolean;
  speed: number;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  plate: string;
  brandName: string;
  modelName: string;
}

interface SoftruckVehicleResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: {
      plate: string;
      brand_name: string;
      model_name: string;
    };
  }>;
}

interface SoftruckDeviceAssociationResponse {
  data: Array<{
    relationships: {
      devices: {
        id: string;
      };
      vehicles: {
        id: string;
      };
    };
  }>;
}

interface SoftruckTrackingResponse {
  data: {
    type: string;
    attributes: {
      ign: boolean;
      act: number;
      spd: number;
      geometry: {
        coordinates: [number, number];
      };
    };
  };
}

export class RastreamentoSoftruck {
  constructor() {
    console.log('[Softruck] Módulo de rastreamento Softruck inicializado');
  }

  // Consultar a última posição do veículo via Softruck
  async ultimaPosicaoSoftruck(
    chassi: string,
  ): Promise<UltimaPosicaoSoftruckResponse> {
    try {
      // STEP 1: Obter vehicle_id e dados do veículo pelo chassi
      const vehicleData = await this.obterVehicleId(chassi);

      // STEP 2: Obter device_id através da associação
      const deviceId = await this.obterDeviceId(vehicleData.id);

      // STEP 3: Obter dados de rastreamento
      const trackingData = await this.obterDadosRastreamento(
        vehicleData.id,
        deviceId,
      );

      // Retornar DTO formatado com dados do veículo e rastreamento
      return this.mapearUltimaPosicaoSoftruck(trackingData, vehicleData);
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      console.error('[Softruck] Erro ao consultar última posição:', error);
      throw new InternalServerErrorException(
        'Erro ao consultar última posição do veículo',
      );
    }
  }

  // STEP 1: Obter vehicle_id pelo chassi
  private async obterVehicleId(chassi: string): Promise<{
    id: string;
    plate: string;
    brandName: string;
    modelName: string;
  }> {
    try {
      const response = await axios.get<SoftruckVehicleResponse>(
        `${process.env.SOFTRUCK_API_BASE_URL}vehicles`,
        {
          params: {
            search: chassi,
          },
          headers: {
            Authorization: `Bearer ${process.env.SOFTRUCK_TOKEN}`,
            'public-key': process.env.PUBLIC_KEY_SOFTRUCK,
          },
        },
      );

      if (
        !response.data ||
        !response.data.data ||
        response.data.data.length === 0
      ) {
        throw new InternalServerErrorException(
          'Veículo não encontrado na base Softruck',
        );
      }

      const vehicleData = response.data.data[0];
      const vehicleId = vehicleData.id;
      const plate = vehicleData.attributes.plate;
      const brandName = vehicleData.attributes.brand_name;
      const modelName = vehicleData.attributes.model_name;

      console.log(
        `[Softruck] Vehicle ID obtido: ${vehicleId} para chassi: ${chassi}`,
      );
      return {
        id: vehicleId,
        plate,
        brandName,
        modelName,
      };
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      console.error('[Softruck] Erro ao obter vehicle_id:', error);
      throw new InternalServerErrorException(
        'Erro ao buscar veículo pelo chassi',
      );
    }
  }

  // STEP 2: Obter device_id através da associação
  private async obterDeviceId(vehicleId: string): Promise<string> {
    try {
      const response = await axios.get<SoftruckDeviceAssociationResponse>(
        `${process.env.SOFTRUCK_API_BASE_URL}vehicles/${vehicleId}/associations/devices`,
        {
          headers: {
            Authorization: `Bearer ${process.env.SOFTRUCK_TOKEN}`,
            'public-key': process.env.PUBLIC_KEY_SOFTRUCK,
          },
        },
      );

      if (
        !response.data ||
        !response.data.data ||
        response.data.data.length === 0
      ) {
        throw new InternalServerErrorException(
          'Dispositivo não associado ao veículo',
        );
      }

      const deviceId = response.data.data[0].relationships.devices.id;
      console.log(
        `[Softruck] Device ID obtido: ${deviceId} para vehicle: ${vehicleId}`,
      );
      return deviceId;
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      console.error('[Softruck] Erro ao obter device_id:', error);
      throw new InternalServerErrorException(
        'Erro ao buscar dispositivo associado ao veículo',
      );
    }
  }

  // STEP 3: Obter dados de rastreamento
  private async obterDadosRastreamento(
    vehicleId: string,
    deviceId: string,
  ): Promise<SoftruckTrackingResponse> {
    try {
      const response = await axios.get<SoftruckTrackingResponse>(
        `${process.env.SOFTRUCK_API_BASE_URL}vehicles/${vehicleId}/tracking/${deviceId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.SOFTRUCK_TOKEN}`,
            'public-key': process.env.PUBLIC_KEY_SOFTRUCK,
          },
        },
      );

      if (!response.data || !response.data.data) {
        throw new InternalServerErrorException(
          'Dados de rastreamento não disponíveis',
        );
      }

      console.log(
        `[Softruck] Dados de rastreamento obtidos para vehicle: ${vehicleId}`,
      );
      return response.data;
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      console.error('[Softruck] Erro ao obter dados de rastreamento:', error);
      throw new InternalServerErrorException(
        'Erro ao buscar dados de rastreamento',
      );
    }
  }

  // Mapear resposta para DTO
  private mapearUltimaPosicaoSoftruck(
    data: SoftruckTrackingResponse,
    vehicleData: {
      id: string;
      plate: string;
      brandName: string;
      modelName: string;
    },
  ): UltimaPosicaoSoftruckResponse {
    const attributes = data.data.attributes;

    // Converter timestamp (act) para formato dd/MM/yyyy HH:mm
    const date = this.formatarData(attributes.act);

    // Extrair coordenadas [longitude, latitude]
    const [longitude, latitude] = attributes.geometry.coordinates;

    return {
      date,
      ign: attributes.ign,
      speed: attributes.spd,
      coordinates: {
        latitude,
        longitude,
      },
      plate: vehicleData.plate,
      brandName: vehicleData.brandName,
      modelName: vehicleData.modelName,
    };
  }

  // Formatar timestamp Unix para dd/MM/yyyy HH:mm
  private formatarData(timestamp: number): string {
    const date = new Date(timestamp * 1000); // Converter de segundos para milissegundos

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }
}
