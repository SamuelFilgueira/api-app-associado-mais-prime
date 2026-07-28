import { BaseOrigin } from 'src/config/tenant.config';

export interface JwtUser {
  userId: number;
  cpf: string;
  username: string;
  role: string;
  baseOrigin: BaseOrigin;
}
