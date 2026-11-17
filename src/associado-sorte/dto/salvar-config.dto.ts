import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SorteFonteCredito } from 'src/associado-sorte/enums/associado-sorte.enums';

export class FaixaRaspadinhaDto {
  @IsInt()
  @Min(1)
  @Max(100_000)
  creditos: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  peso: number;
}

export class MarcoSequenciaDto {
  @IsInt()
  @Min(2)
  @Max(365)
  dias: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  bonus: number;
}

/**
 * `PUT config/:baseOrigin`. Todos os campos são opcionais: as telas
 * "Créditos" e "Configurações" do painel gravam blocos diferentes da mesma
 * linha; o que não vier fica como está.
 */
export class SalvarConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ativa?: boolean;

  @ApiPropertyOptional({ example: 'Associado da Sorte' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  titulo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  subtitulo?: string | null;

  @ApiPropertyOptional({ description: 'Texto do regulamento exibido no app' })
  @IsOptional()
  @IsString()
  @MaxLength(60_000)
  regulamento?: string | null;

  @ApiPropertyOptional({ example: '21999998888' })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  whatsappSuporte?: string | null;

  @ApiPropertyOptional({ enum: SorteFonteCredito })
  @IsOptional()
  @IsEnum(SorteFonteCredito)
  fonteCreditoDiario?: SorteFonteCredito;

  @ApiPropertyOptional({ type: [FaixaRaspadinhaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => FaixaRaspadinhaDto)
  faixasRaspadinha?: FaixaRaspadinhaDto[];

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  creditosCheckin?: number;

  @ApiPropertyOptional({ type: [MarcoSequenciaDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MarcoSequenciaDto)
  marcosSequencia?: MarcoSequenciaDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  exibirGanhadores?: boolean;

  @ApiPropertyOptional({ description: 'Dias de carência (0 desliga)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  carenciaDias?: number;

  // ------------------------------------------------------------------- v2

  @ApiPropertyOptional({
    example: '3677',
    description: 'Código do produto no SGA',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  produtoSgaCodigo?: string;

  @ApiPropertyOptional({ example: 'ASSOCIADO DA SORTE' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  produtoSgaDescricao?: string;

  @ApiPropertyOptional({
    example: 6,
    description: 'Validade da verificação no SGA (horas)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  inscricaoValidadeHoras?: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  raspadasPorDia?: number;

  @ApiPropertyOptional({
    example: 60,
    description: 'Minutos entre duas raspadas no mesmo dia',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  intervaloMinimoMinutos?: number;

  @ApiPropertyOptional({
    description: 'Jornada de check-in (marcos em marcosSequencia)',
  })
  @IsOptional()
  @IsBoolean()
  jornadaAtiva?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  lembretesAtivos?: boolean;

  @ApiPropertyOptional({ example: '08:00', description: 'HH:MM (Brasília)' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'lembreteInicio deve ser HH:MM',
  })
  lembreteInicio?: string;

  @ApiPropertyOptional({ example: '21:00', description: 'HH:MM (Brasília)' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'lembreteFim deve ser HH:MM',
  })
  lembreteFim?: string;

  @ApiPropertyOptional({
    example: '21999998888',
    description: 'Vazio/null remove',
  })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  whatsappConvite?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  mensagemConvite?: string;

  @ApiPropertyOptional({
    example: 'marketing@teste.com.br, outro@teste.com.br',
    description: 'Um ou mais e-mails separados por vírgula',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  emailNotificacoes?: string;

  @ApiPropertyOptional({
    example: '21999998888',
    description: 'Vazio/null remove o botão',
  })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  whatsappMarketing?: string | null;

  @ApiPropertyOptional({
    description: 'Rodadas (SORTEIO/CORRIDA/RESGATE) no app',
  })
  @IsOptional()
  @IsBoolean()
  rodadasHabilitadas?: boolean;
}
