import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  TIPOS_MENSAGEM,
  TipoMensagem,
} from 'src/boleto-notificacao/config/boleto-notificacao.config';

/** Corpo de POST /boleto-notificacao/admin/executar. */
export class ExecutarRotinaDto {
  /** Data de referência ("hoje" da rotina) em dd/mm/yyyy. Default: data atual. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}\/\d{2}\/\d{4}$/, {
    message: 'dataReferencia deve estar no formato dd/mm/yyyy',
  })
  dataReferencia?: string;

  /** Subconjunto de tenants (default: todos os configurados). */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  tenants?: string[];

  /** Subconjunto de momentos do ciclo (default: D0, D5, D6). */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(TIPOS_MENSAGEM, { each: true })
  tipos?: TipoMensagem[];

  /** Simula sem enviar push nem gravar logs/execuções. Default: false. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** true = executa na própria requisição e devolve o resultado; false = enfileira no BullMQ. Default: false. */
  @IsOptional()
  @IsBoolean()
  sync?: boolean;
}
