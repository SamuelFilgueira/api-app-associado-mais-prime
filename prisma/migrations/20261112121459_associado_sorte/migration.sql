-- CreateTable
CREATE TABLE `SorteConfig` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `ativa` BOOLEAN NOT NULL DEFAULT false,
    `titulo` VARCHAR(80) NOT NULL DEFAULT 'Associado da Sorte',
    `subtitulo` VARCHAR(160) NULL,
    `regulamento` TEXT NULL,
    `regulamentoAtualizadoEm` DATETIME(3) NULL,
    `whatsappSuporte` VARCHAR(20) NULL,
    `fonteCreditoDiario` ENUM('RASPADINHA', 'CHECKIN', 'NENHUMA') NOT NULL DEFAULT 'RASPADINHA',
    `faixasRaspadinha` JSON NULL,
    `creditosCheckin` INTEGER NOT NULL DEFAULT 1,
    `marcosSequencia` JSON NULL,
    `exibirGanhadores` BOOLEAN NOT NULL DEFAULT true,
    `carenciaDias` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SorteConfig_baseOrigin_key`(`baseOrigin`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteCarteira` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `saldo` INTEGER NOT NULL DEFAULT 0,
    `totalGanho` INTEGER NOT NULL DEFAULT 0,
    `sequenciaDias` INTEGER NOT NULL DEFAULT 0,
    `ultimoDiaColetado` DATE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SorteCarteira_userId_key`(`userId`),
    INDEX `SorteCarteira_baseOrigin_saldo_idx`(`baseOrigin`, `saldo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteCreditoLancamento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `tipo` VARCHAR(40) NOT NULL,
    `valor` INTEGER NOT NULL,
    `saldoApos` INTEGER NOT NULL,
    `rodadaId` INTEGER NULL,
    `descricao` VARCHAR(200) NULL,
    `autorId` INTEGER NULL,
    `autorNome` VARCHAR(150) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteCreditoLancamento_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `SorteCreditoLancamento_baseOrigin_tipo_createdAt_idx`(`baseOrigin`, `tipo`, `createdAt`),
    INDEX `SorteCreditoLancamento_rodadaId_idx`(`rodadaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteColetaDiaria` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `dia` DATE NOT NULL,
    `fonte` ENUM('RASPADINHA', 'CHECKIN', 'NENHUMA') NOT NULL,
    `creditos` INTEGER NOT NULL,
    `bonus` INTEGER NOT NULL DEFAULT 0,
    `sequencia` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteColetaDiaria_baseOrigin_dia_idx`(`baseOrigin`, `dia`),
    UNIQUE INDEX `SorteColetaDiaria_userId_dia_key`(`userId`, `dia`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SortePremio` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(120) NOT NULL,
    `descricao` TEXT NULL,
    `imagemUrl` VARCHAR(500) NULL,
    `valorEstimado` DECIMAL(10, 2) NULL,
    `estoque` INTEGER NOT NULL DEFAULT 0,
    `ativo` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `SortePremio_ativo_deletedAt_idx`(`ativo`, `deletedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteEstoqueMovimento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `premioId` INTEGER NOT NULL,
    `tipo` ENUM('ENTRADA', 'SAIDA_GANHADOR', 'AJUSTE', 'ESTORNO') NOT NULL,
    `quantidade` INTEGER NOT NULL,
    `estoqueApos` INTEGER NOT NULL,
    `motivo` VARCHAR(200) NULL,
    `rodadaId` INTEGER NULL,
    `ganhadorId` INTEGER NULL,
    `autorId` INTEGER NULL,
    `autorNome` VARCHAR(150) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteEstoqueMovimento_premioId_createdAt_idx`(`premioId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteRodada` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `premioId` INTEGER NOT NULL,
    `titulo` VARCHAR(120) NULL,
    `mecanica` ENUM('SORTEIO', 'CORRIDA', 'RESGATE') NOT NULL,
    `quantidade` INTEGER NOT NULL,
    `quantidadeRestante` INTEGER NOT NULL,
    `custoCreditos` INTEGER NOT NULL DEFAULT 0,
    `modoCredito` ENUM('CONSOME', 'SALDO_MINIMO') NOT NULL DEFAULT 'CONSOME',
    `bilhetesMaximos` INTEGER NOT NULL DEFAULT 1,
    `abertura` DATETIME(3) NOT NULL,
    `encerramento` DATETIME(3) NOT NULL,
    `estado` ENUM('RASCUNHO', 'PUBLICADA', 'APURANDO', 'ENCERRADA', 'CANCELADA') NOT NULL DEFAULT 'RASCUNHO',
    `apuradaEm` DATETIME(3) NULL,
    `resumoApuracao` JSON NULL,
    `lembreteEnviadoEm` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SorteRodada_estado_abertura_idx`(`estado`, `abertura`),
    INDEX `SorteRodada_estado_encerramento_idx`(`estado`, `encerramento`),
    INDEX `SorteRodada_premioId_estado_idx`(`premioId`, `estado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteRodadaBase` (
    `rodadaId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,

    INDEX `SorteRodadaBase_baseOrigin_idx`(`baseOrigin`),
    PRIMARY KEY (`rodadaId`, `baseOrigin`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteParticipacao` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rodadaId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `bilhetes` INTEGER NOT NULL DEFAULT 1,
    `creditosGastos` INTEGER NOT NULL DEFAULT 0,
    `estornadoEm` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteParticipacao_userId_idx`(`userId`),
    UNIQUE INDEX `SorteParticipacao_rodadaId_userId_key`(`rodadaId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteLembrete` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rodadaId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SorteLembrete_rodadaId_userId_key`(`rodadaId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteGanhador` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rodadaId` INTEGER NOT NULL,
    `premioId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `codigo` VARCHAR(12) NOT NULL,
    `origem` ENUM('SORTEIO', 'CORRIDA', 'RESGATE') NOT NULL,
    `situacao` ENUM('AGUARDANDO_CONTATO', 'EM_CONTATO', 'ENTREGUE', 'CANCELADO') NOT NULL DEFAULT 'AGUARDANDO_CONTATO',
    `telefoneContato` VARCHAR(20) NULL,
    `telefoneConfirmadoEm` DATETIME(3) NULL,
    `observacao` TEXT NULL,
    `creditosGastos` INTEGER NOT NULL DEFAULT 0,
    `estoqueDevolvido` BOOLEAN NOT NULL DEFAULT false,
    `entregueEm` DATETIME(3) NULL,
    `canceladoEm` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SorteGanhador_codigo_key`(`codigo`),
    INDEX `SorteGanhador_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `SorteGanhador_baseOrigin_situacao_idx`(`baseOrigin`, `situacao`),
    INDEX `SorteGanhador_premioId_idx`(`premioId`),
    UNIQUE INDEX `SorteGanhador_rodadaId_userId_key`(`rodadaId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SorteCarteira` ADD CONSTRAINT `SorteCarteira_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteEstoqueMovimento` ADD CONSTRAINT `SorteEstoqueMovimento_premioId_fkey` FOREIGN KEY (`premioId`) REFERENCES `SortePremio`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteRodada` ADD CONSTRAINT `SorteRodada_premioId_fkey` FOREIGN KEY (`premioId`) REFERENCES `SortePremio`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteRodadaBase` ADD CONSTRAINT `SorteRodadaBase_rodadaId_fkey` FOREIGN KEY (`rodadaId`) REFERENCES `SorteRodada`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteParticipacao` ADD CONSTRAINT `SorteParticipacao_rodadaId_fkey` FOREIGN KEY (`rodadaId`) REFERENCES `SorteRodada`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteParticipacao` ADD CONSTRAINT `SorteParticipacao_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteLembrete` ADD CONSTRAINT `SorteLembrete_rodadaId_fkey` FOREIGN KEY (`rodadaId`) REFERENCES `SorteRodada`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteLembrete` ADD CONSTRAINT `SorteLembrete_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteGanhador` ADD CONSTRAINT `SorteGanhador_rodadaId_fkey` FOREIGN KEY (`rodadaId`) REFERENCES `SorteRodada`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteGanhador` ADD CONSTRAINT `SorteGanhador_premioId_fkey` FOREIGN KEY (`premioId`) REFERENCES `SortePremio`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteGanhador` ADD CONSTRAINT `SorteGanhador_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
