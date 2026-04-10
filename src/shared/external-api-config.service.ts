import { Injectable, Scope } from '@nestjs/common';
import { BaseContextService } from './base-context.service';
import { SgaAuthCredentials } from './token-resolver.service';

export interface ExternalApiConfig {
  sgaAuthCredentials: SgaAuthCredentials;
  logicaToken: string;
  softruckToken: string;
  softruckPublicKey: string;
  clubgasToken: string;
  m7Token: string;
  m7Codigo: string;
}

@Injectable({ scope: Scope.REQUEST })
export class ExternalApiConfigService {
  constructor(private readonly baseContext: BaseContextService) {}

  getConfig(): ExternalApiConfig {
    return {
      sgaAuthCredentials: this.baseContext.getSgaAuthCredentials(),
      logicaToken: this.baseContext.getLogicaToken(),
      softruckToken: this.baseContext.getSoftruckToken(),
      softruckPublicKey: this.baseContext.getSoftruckPublicKey(),
      clubgasToken: this.baseContext.getClubgasToken(),
      m7Token: this.baseContext.getM7Token(),
      m7Codigo: this.baseContext.getM7Codigo(),
    };
  }
}
