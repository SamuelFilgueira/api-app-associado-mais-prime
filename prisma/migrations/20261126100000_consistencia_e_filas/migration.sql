-- Consistência e filas (plano de arquitetura, fase 4).
--
-- Só ACRESCENTA: colunas anuláveis, tabelas novas e índices. Nenhuma linha
-- existente é alterada e nenhuma coluna existente muda de tipo.
--
--  * ChaveDeIdempotencia ...... repetição de escrita com `Idempotency-Key`
--  * OutboxEvento ............. evento gravado na transação do fato
--  * PushDisparo / PushEntrega  push em massa por lotes, com uma linha por destinatário
--  * VeiculoComandoLog ........ auditoria de âncora e alerta de ignição
--  * ReinspectionPayment ...... dados da verificação por varredura
--    (`proximaConsultaEm` nulo = boleto antigo, ainda acompanhado pelo job repetível)
--  * Reinspection ............. lease da geração do boleto
--  * UserVehicle .............. provedor de rastreamento e âncora/ignição por veículo
--  * índices únicos sobre colunas NOVAS e nulas (não conflitam com dados existentes):
--    VehicleWebhookEvent.eventoHash, FuelSession.pendenteChave,
--    DirectPartnerCouponRedemption.chaveUsoUnico
--
-- Em tabelas grandes (Notification, user) a criação de índice é online no
-- InnoDB, mas consome I/O: aplicar fora do horário de pico.

-- AlterTable
ALTER TABLE `DirectPartnerCouponRedemption` ADD COLUMN `chaveUsoUnico` VARCHAR(40) NULL;

-- AlterTable
ALTER TABLE `FuelSession` ADD COLUMN `pendenteChave` VARCHAR(40) NULL;

-- AlterTable
ALTER TABLE `Reinspection` ADD COLUMN `boletoLeaseAte` DATETIME(3) NULL,
    ADD COLUMN `boletoLeaseDono` VARCHAR(40) NULL;

-- AlterTable
ALTER TABLE `ReinspectionPayment` ADD COLUMN `baseOrigin` VARCHAR(50) NULL,
    ADD COLUMN `codigoAssociado` INTEGER NULL,
    ADD COLUMN `codigoVeiculo` VARCHAR(50) NULL,
    ADD COLUMN `nomeAssociado` VARCHAR(255) NULL,
    ADD COLUMN `proximaConsultaEm` DATETIME(3) NULL,
    ADD COLUMN `telefoneAssociado` VARCHAR(30) NULL,
    ADD COLUMN `verificacaoEncerradaEm` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `UserVehicle` ADD COLUMN `ancoraAtiva` BOOLEAN NULL,
    ADD COLUMN `notificacaoIgnicao` BOOLEAN NULL,
    ADD COLUMN `provedorFalhas` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `provedorRastreamento` VARCHAR(20) NULL,
    ADD COLUMN `provedorVerificadoEm` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `VehicleWebhookEvent` ADD COLUMN `eventoHash` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `ChaveDeIdempotencia` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `escopo` VARCHAR(60) NOT NULL,
    `chave` VARCHAR(100) NOT NULL,
    `corpoHash` VARCHAR(64) NOT NULL,
    `estado` VARCHAR(20) NOT NULL DEFAULT 'EM_ANDAMENTO',
    `statusHttp` INTEGER NULL,
    `resposta` JSON NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiraEm` DATETIME(3) NOT NULL,

    INDEX `ChaveDeIdempotencia_expiraEm_idx`(`expiraEm`),
    UNIQUE INDEX `ChaveDeIdempotencia_user_escopo_chave_key`(`userId`, `escopo`, `chave`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo` VARCHAR(80) NOT NULL,
    `chave` VARCHAR(150) NOT NULL,
    `baseOrigin` VARCHAR(50) NULL,
    `payload` JSON NOT NULL,
    `estado` VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    `tentativas` INTEGER NOT NULL DEFAULT 0,
    `proximaTentativaEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ultimoErro` VARCHAR(500) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publicadoEm` DATETIME(3) NULL,

    INDEX `OutboxEvento_estado_proximaTentativa_idx`(`estado`, `proximaTentativaEm`),
    UNIQUE INDEX `OutboxEvento_tipo_chave_key`(`tipo`, `chave`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PushDisparo` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo` VARCHAR(30) NOT NULL,
    `marketingAuditLogId` INTEGER NULL,
    `titulo` VARCHAR(255) NOT NULL,
    `corpo` TEXT NOT NULL,
    `dados` JSON NOT NULL,
    `estado` VARCHAR(20) NOT NULL DEFAULT 'CRIADO',
    `totalDestinatarios` INTEGER NOT NULL DEFAULT 0,
    `totalEnviadas` INTEGER NOT NULL DEFAULT 0,
    `totalRecusadas` INTEGER NOT NULL DEFAULT 0,
    `totalFalhas` INTEGER NOT NULL DEFAULT 0,
    `batimentoEm` DATETIME(3) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `concluidoEm` DATETIME(3) NULL,

    INDEX `PushDisparo_estado_batimento_idx`(`estado`, `batimentoEm`),
    INDEX `PushDisparo_marketingAuditLogId_idx`(`marketingAuditLogId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PushEntrega` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `disparoId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `expoPushToken` VARCHAR(255) NOT NULL,
    `estado` VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    `ticketId` VARCHAR(100) NULL,
    `erro` VARCHAR(255) NULL,
    `tentativas` INTEGER NOT NULL DEFAULT 0,
    `enviadaEm` DATETIME(3) NULL,
    `reciboEm` DATETIME(3) NULL,

    INDEX `PushEntrega_disparo_estado_idx`(`disparoId`, `estado`, `id`),
    INDEX `PushEntrega_estado_enviadaEm_idx`(`estado`, `enviadaEm`),
    UNIQUE INDEX `PushEntrega_disparo_user_key`(`disparoId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VeiculoComandoLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `userVehicleId` INTEGER NULL,
    `chassi` VARCHAR(100) NOT NULL,
    `baseOrigin` VARCHAR(50) NULL,
    `comando` VARCHAR(20) NOT NULL,
    `valor` BOOLEAN NOT NULL,
    `resultado` VARCHAR(10) NOT NULL,
    `erro` VARCHAR(255) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VeiculoComandoLog_chassi_criadoEm_idx`(`chassi`, `criadoEm`),
    INDEX `VeiculoComandoLog_userId_criadoEm_idx`(`userId`, `criadoEm`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `DirectPartnerCouponRedemption_chaveUsoUnico_key` ON `DirectPartnerCouponRedemption`(`chaveUsoUnico`);

-- CreateIndex
CREATE UNIQUE INDEX `FuelSession_pendenteChave_key` ON `FuelSession`(`pendenteChave`);

-- CreateIndex
CREATE INDEX `Notification_userId_deleted_sentAt_idx` ON `Notification`(`userId`, `deleted`, `sentAt`);

-- CreateIndex
CREATE INDEX `Reinspection_userVehicleId_createdAt_idx` ON `Reinspection`(`userVehicleId`, `createdAt`);

-- CreateIndex
CREATE INDEX `Reinspection_boletoStatus_proximaTentativa_idx` ON `Reinspection`(`boletoStatus`, `boletoProximaTentativaEm`);

-- CreateIndex
CREATE INDEX `ReinspectionPayment_varredura_idx` ON `ReinspectionPayment`(`verificacaoEncerradaEm`, `proximaConsultaEm`);

-- CreateIndex
CREATE INDEX `UserVehicle_plate_idx` ON `UserVehicle`(`plate`);

-- CreateIndex
CREATE UNIQUE INDEX `VehicleWebhookEvent_eventoHash_key` ON `VehicleWebhookEvent`(`eventoHash`);

-- CreateIndex
CREATE INDEX `User_baseOrigin_isActive_idx` ON `user`(`baseOrigin`, `isActive`);

-- AddForeignKey
ALTER TABLE `PushEntrega` ADD CONSTRAINT `PushEntrega_disparoId_fkey` FOREIGN KEY (`disparoId`) REFERENCES `PushDisparo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

