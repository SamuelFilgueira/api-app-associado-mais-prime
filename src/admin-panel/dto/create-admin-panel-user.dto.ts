import { AdminPanelRole } from '@prisma/client';
import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CreateAdminPanelUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsEnum(AdminPanelRole)
  role: AdminPanelRole;
}
