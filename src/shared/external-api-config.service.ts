import { Injectable, Scope } from '@nestjs/common';
import { BaseContextService } from './base-context.service';

export interface ExternalApiConfig {
  sgaToken: string;
  logicaToken: string;
  softruckToken: string;
  softruckPublicKey: string;
}

@Injectable({ scope: Scope.REQUEST })
export class ExternalApiConfigService {
  constructor(private readonly baseContext: BaseContextService) {}

  getConfig(): ExternalApiConfig {
    return {
      sgaToken: this.baseContext.getSgaToken(),
      logicaToken: this.baseContext.getLogicaToken(),
      softruckToken: this.baseContext.getSoftruckToken(),
      softruckPublicKey: this.baseContext.getSoftruckPublicKey(),
    };
  }
}
