import { IsString, MinLength } from 'class-validator';

export class ChangeAdminPanelPasswordDto {
  /** Senha vigente — obrigatória: um token vazado não basta para trocar a senha. */
  @IsString()
  @MinLength(6)
  currentPassword: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}
