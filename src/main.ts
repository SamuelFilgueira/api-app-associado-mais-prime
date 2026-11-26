process.env.TZ = 'America/Sao_Paulo';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import compression from 'compression';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  json,
  urlencoded,
} from 'express';
import { validateEnvOrThrow } from './config/env.validator';
import { TENANT } from './config/tenant.config';
import { AppConfig, appConfig } from './config/app.config';
import { LoggingInterceptor } from './infra/interceptors/logging.interceptor';
import { AllExceptionsFilter } from './infra/filters/all-exceptions.filter';
import { LoggerEstruturado } from './infra/observability/logger-estruturado';
import { requisicaoMiddleware } from './infra/observability/requisicao.middleware';
import {
  iniciarMetricasDeProcesso,
  metricas,
} from './infra/observability/metricas';

/** Rotas fora do prefixo `/api`: sondas e métricas. */
const ROTAS_SEM_PREFIXO = ['health', 'health/live', 'health/ready', 'metrics'];

async function bootstrap() {
  let config: AppConfig;
  // Validate required environment variables before starting the app
  try {
    config = appConfig();
    // Já a partir daqui as linhas saem no formato configurado (JSON em
    // produção), inclusive as da validação de ambiente.
    Logger.overrideLogger(new LoggerEstruturado(config));
    validateEnvOrThrow();
  } catch (err) {
    const logger = new Logger('Bootstrap');
    logger.error('App startup aborted due to invalid environment', err);
    process.exit(1);
  }

  const logger = new LoggerEstruturado(config);
  registrarErrosDeProcesso();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    // Os parsers de corpo são registrados abaixo, com limite por rota.
    bodyParser: false,
  });

  iniciarMetricasDeProcesso(config.role);

  // Atrás do proxy, `req.ip` precisa ser o do cliente: é ele que vai para a
  // auditoria e para as janelas de limite por IP.
  if (config.http.trustProxy !== false) {
    app.set('trust proxy', config.http.trustProxy);
  }

  // Primeiro da cadeia: requestId, contexto de log, linha de acesso e métricas.
  app.use(requisicaoMiddleware);

  if (config.emProducao && !config.http.corsOrigins) {
    new Logger('Bootstrap').warn(
      'CORS aberto para qualquer origem: defina CORS_ORIGINS com as origens do painel.',
    );
  }
  app.enableCors({
    origin: config.http.corsOrigins ?? true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
    ],
    exposedHeaders: ['Content-Disposition', 'X-Request-Id', 'Retry-After'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.use(helmet());
  // Gzip nas respostas: o app consome listas JSON grandes (postos, oficinas,
  // benefícios, boletos) por rede móvel. Só comprime acima de 1kb e apenas
  // content-types marcados como compressíveis — PDF/XLSX passam intactos.
  app.use(compression());
  // Corpo de 1 MB por padrão; 20 MB só onde o JSON carrega fotos em base64
  // (revistoria) ou planilha (cronograma do Associado da Sorte). Antes o
  // limite de 20 MB valia para a API inteira, inclusive rotas anônimas.
  app.use(parserPorRota(config, (limit) => json({ limit })));
  app.use(
    parserPorRota(config, (limit) => urlencoded({ extended: true, limit })),
  );
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api', { exclude: ROTAS_SEM_PREFIXO });

  // Serve static files from uploads directory.
  // O helmet() acima envia `Cross-Origin-Resource-Policy: same-origin` em toda
  // resposta, o que faz o navegador bloquear <img src="/uploads/..."> quando a
  // página está em outra origem (painel admin em domínio próprio). Os arquivos
  // de /uploads são públicos, então aqui o CORP é relaxado para cross-origin.
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

  // Em produção a documentação só sobe com SWAGGER_ENABLED=true.
  if (config.http.swaggerHabilitado) {
    const swagger = new DocumentBuilder()
      .setTitle(`Benefícios API — ${TENANT.name}`)
      .setVersion('1.0')
      .build();
    const doc = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup('docs', app, doc);
  }

  // SIGTERM/SIGINT fecham a aplicação em ordem: o HTTP para de aceitar
  // conexões, os workers do BullMQ terminam o job em curso e as conexões com
  // banco e Redis são encerradas. Sem isto o `docker stop` terminava em
  // SIGKILL e os jobs ativos voltavam como "stalled".
  app.enableShutdownHooks();

  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `Aplicação no ar | papel=${config.role} | porta=${config.port} | ambiente=${config.ambiente} | log=${config.log.formato}`,
  );
}

/**
 * Escolhe o parser de corpo pelo caminho: limite grande só nas rotas
 * listadas em `rotasCorpoGrande`.
 */
function parserPorRota(
  config: AppConfig,
  criar: (limite: string) => RequestHandler,
): RequestHandler {
  const padrao = criar(config.http.limiteCorpoPadrao);
  const grande = criar(config.http.limiteCorpoGrande);
  const prefixos = config.http.rotasCorpoGrande;

  return (req: Request, res: Response, next: NextFunction) => {
    const usarGrande = prefixos.some(
      (prefixo) => req.path === prefixo || req.path.startsWith(`${prefixo}/`),
    );
    (usarGrande ? grande : padrao)(req, res, next);
  };
}

/**
 * Promessa rejeitada sem `catch` e exceção fora de qualquer `try` deixam de
 * passar em silêncio: viram linha de log estruturada e métrica.
 */
function registrarErrosDeProcesso(): void {
  const logger = new Logger('Processo');

  process.on('unhandledRejection', (motivo: unknown) => {
    metricas.errosNaoTratados.inc({ tipo: 'unhandledRejection' });
    logger.error(
      `Promessa rejeitada sem tratamento: ${motivo instanceof Error ? motivo.message : String(motivo)}`,
      motivo instanceof Error ? motivo.stack : undefined,
    );
  });

  process.on('uncaughtException', (erro: Error) => {
    metricas.errosNaoTratados.inc({ tipo: 'uncaughtException' });
    logger.error(`Exceção não capturada: ${erro.message}`, erro.stack);
    // O estado do processo é desconhecido: encerra para o orquestrador
    // subir uma instância limpa.
    setTimeout(() => process.exit(1), 200).unref();
  });
}

void bootstrap();
