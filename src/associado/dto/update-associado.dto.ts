import { IsEmail, IsOptional, IsString } from 'class-validator';

/**
 * Campos que o associado (ou o painel) pode alterar no cadastro.
 *
 * `cpf` e `profilePhotoUrl` ficaram de fora de propósito: o CPF é a
 * identidade do associado no SGA, e o caminho da foto é definido pelo servidor
 * no upload (`profilePhoto`) — vindo do cliente, ele apontava a exclusão de
 * arquivo para qualquer caminho. Com `whitelist: true`, os dois são
 * descartados em silêncio se um cliente antigo ainda os enviar.
 */
export class UpdateAssociadoDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  cep?: string;

  @IsOptional()
  @IsString()
  address?: string;
}
