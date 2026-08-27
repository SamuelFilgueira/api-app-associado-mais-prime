-- CreateTable
CREATE TABLE `BoletoNotificacaoExecucao` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tenant` VARCHAR(50) NOT NULL,
    `tipoMensagem` ENUM('D0', 'D5', 'D6') NOT NULL,
    `dataReferencia` DATE NOT NULL,
    `dataAlvo` DATE NOT NULL,
    `status` ENUM('EM_ANDAMENTO', 'CONCLUIDA', 'PULADA', 'FALHA') NOT NULL DEFAULT 'EM_ANDAMENTO',
    `origem` VARCHAR(20) NOT NULL DEFAULT 'AGENDADA',
    `dryRun` BOOLEAN NOT NULL DEFAULT false,
    `totalRegistrosSga` INTEGER NOT NULL DEFAULT 0,
    `totalPaginasSga` INTEGER NOT NULL DEFAULT 0,
    `totalBoletosElegiveis` INTEGER NOT NULL DEFAULT 0,
    `totalAssociados` INTEGER NOT NULL DEFAULT 0,
    `totalSemUsuario` INTEGER NOT NULL DEFAULT 0,
    `totalSemToken` INTEGER NOT NULL DEFAULT 0,
    `totalIdempotentes` INTEGER NOT NULL DEFAULT 0,
    `totalDuplicadosUsuario` INTEGER NOT NULL DEFAULT 0,
    `totalEnfileirados` INTEGER NOT NULL DEFAULT 0,
    `totalEnviados` INTEGER NOT NULL DEFAULT 0,
    `totalEntregues` INTEGER NOT NULL DEFAULT 0,
    `totalFalhas` INTEGER NOT NULL DEFAULT 0,
    `totalTokensInvalidos` INTEGER NOT NULL DEFAULT 0,
    `coberturaElegiveis` DOUBLE NULL,
    `coberturaEntrega` DOUBLE NULL,
    `receiptsVerificadosEm` DATETIME(3) NULL,
    `erro` TEXT NULL,
    `iniciadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finalizadoEm` DATETIME(3) NULL,

    INDEX `BoletoNotificacaoExecucao_tenant_dataAlvo_tipo_idx`(`tenant`, `dataAlvo`, `tipoMensagem`),
    INDEX `BoletoNotificacaoExecucao_iniciadoEm_idx`(`iniciadoEm`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BoletoNotificacaoLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `execucaoId` INTEGER NOT NULL,
    `tenant` VARCHAR(50) NOT NULL,
    `codigoAssociado` INTEGER NOT NULL,
    `cpf` VARCHAR(11) NOT NULL,
    `userId` INTEGER NULL,
    `nossoNumero` VARCHAR(50) NULL,
    `quantidadeBoletos` INTEGER NOT NULL DEFAULT 1,
    `dataVencimentoOriginal` DATE NOT NULL,
    `tipoMensagem` ENUM('D0', 'D5', 'D6') NOT NULL,
    `expoPushToken` VARCHAR(255) NULL,
    `statusEnvio` ENUM('ENFILEIRADO', 'ENVIADO', 'ENTREGUE', 'FALHA') NOT NULL DEFAULT 'ENFILEIRADO',
    `expoTicketId` VARCHAR(100) NULL,
    `expoErro` VARCHAR(255) NULL,
    `mensagemTitulo` VARCHAR(255) NOT NULL,
    `mensagemEnviada` TEXT NOT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,

    INDEX `BoletoNotificacaoLog_execucaoId_statusEnvio_idx`(`execucaoId`, `statusEnvio`),
    INDEX `BoletoNotificacaoLog_userId_idx`(`userId`),
    UNIQUE INDEX `BoletoNotificacaoLog_idempotencia_key`(`tenant`, `codigoAssociado`, `dataVencimentoOriginal`, `tipoMensagem`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BoletoNotificacaoLog` ADD CONSTRAINT `BoletoNotificacaoLog_execucaoId_fkey` FOREIGN KEY (`execucaoId`) REFERENCES `BoletoNotificacaoExecucao`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
