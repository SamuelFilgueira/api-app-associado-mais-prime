-- DropForeignKey
ALTER TABLE `SorteGanhador` DROP FOREIGN KEY `SorteGanhador_rodadaId_fkey`;

-- DropIndex
DROP INDEX `SorteGanhador_rodadaId_userId_key` ON `SorteGanhador`;

-- AlterTable
ALTER TABLE `SorteCarteira` ADD COLUMN `lembreteRaspadaEm` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `SorteConfig` ADD COLUMN `emailNotificacoes` VARCHAR(500) NOT NULL DEFAULT 'marketing@teste.com.br',
    ADD COLUMN `inscricaoValidadeHoras` INTEGER NOT NULL DEFAULT 6,
    ADD COLUMN `intervaloMinimoMinutos` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `jornadaAtiva` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `lembreteFim` VARCHAR(5) NOT NULL DEFAULT '21:00',
    ADD COLUMN `lembreteInicio` VARCHAR(5) NOT NULL DEFAULT '08:00',
    ADD COLUMN `lembretesAtivos` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `mensagemConvite` VARCHAR(500) NOT NULL DEFAULT 'Olá, sou associado da Mais Prime e gostaria de saber sobre a promoção do associado da sorte',
    ADD COLUMN `produtoSgaCodigo` VARCHAR(20) NOT NULL DEFAULT '3677',
    ADD COLUMN `produtoSgaDescricao` VARCHAR(120) NOT NULL DEFAULT 'ASSOCIADO DA SORTE',
    ADD COLUMN `raspadasPorDia` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `rodadasHabilitadas` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `whatsappConvite` VARCHAR(20) NULL,
    ADD COLUMN `whatsappMarketing` VARCHAR(20) NULL;

-- AlterTable
ALTER TABLE `SorteGanhador` MODIFY `rodadaId` INTEGER NULL,
    MODIFY `origem` ENUM('SORTEIO', 'CORRIDA', 'RESGATE', 'LOJA') NOT NULL;

-- AlterTable
ALTER TABLE `SortePremio` ADD COLUMN `custoCreditos` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `instrucoesRetirada` TEXT NULL,
    ADD COLUMN `limitePorAssociado` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `naLoja` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `ordem` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `tipo` ENUM('FISICO', 'SERVICO_MAIS_PRIME', 'CUPOM_PARCEIRO') NOT NULL DEFAULT 'FISICO';

-- CreateTable
CREATE TABLE `SorteCampanha` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `nome` VARCHAR(120) NOT NULL,
    `inicio` DATETIME(3) NOT NULL,
    `fim` DATETIME(3) NOT NULL,
    `estado` ENUM('RASCUNHO', 'PUBLICADA', 'ENCERRADA') NOT NULL DEFAULT 'RASCUNHO',
    `publicadaEm` DATETIME(3) NULL,
    `publicadaPorId` INTEGER NULL,
    `publicadaPorNome` VARCHAR(150) NULL,
    `hashCronograma` VARCHAR(64) NULL,
    `encerradaEm` DATETIME(3) NULL,
    `encerradaPorId` INTEGER NULL,
    `encerradaPorNome` VARCHAR(150) NULL,
    `motivoEncerramento` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SorteCampanha_baseOrigin_estado_idx`(`baseOrigin`, `estado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteMomentoPremiado` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `campanhaId` INTEGER NOT NULL,
    `liberaEm` DATETIME(3) NOT NULL,
    `creditos` INTEGER NOT NULL,
    `descricao` VARCHAR(200) NULL,
    `userId` INTEGER NULL,
    `ganhoEm` DATETIME(3) NULL,
    `raspadaId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteMomentoPremiado_campanhaId_userId_liberaEm_idx`(`campanhaId`, `userId`, `liberaEm`),
    INDEX `SorteMomentoPremiado_campanhaId_liberaEm_idx`(`campanhaId`, `liberaEm`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteRaspada` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `campanhaId` INTEGER NOT NULL,
    `dia` DATE NOT NULL,
    `resultado` ENUM('GANHOU', 'NAO_GANHOU') NOT NULL,
    `momentoId` INTEGER NULL,
    `creditos` INTEGER NOT NULL DEFAULT 0,
    `bonus` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteRaspada_userId_dia_idx`(`userId`, `dia`),
    INDEX `SorteRaspada_campanhaId_createdAt_idx`(`campanhaId`, `createdAt`),
    INDEX `SorteRaspada_baseOrigin_dia_idx`(`baseOrigin`, `dia`),
    INDEX `SorteRaspada_userId_resultado_createdAt_idx`(`userId`, `resultado`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteInscricao` (
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `inscrito` BOOLEAN NOT NULL,
    `fonte` ENUM('SGA', 'MANUAL') NOT NULL,
    `codigoVeiculo` VARCHAR(30) NULL,
    `verificadoEm` DATETIME(3) NULL,
    `autorId` INTEGER NULL,
    `autorNome` VARCHAR(150) NULL,
    `motivo` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SorteInscricao_baseOrigin_inscrito_idx`(`baseOrigin`, `inscrito`),
    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteTentativa` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `acao` ENUM('RASPAR', 'COMPRAR', 'ACESSAR') NOT NULL,
    `codigo` VARCHAR(60) NOT NULL,
    `contexto` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteTentativa_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SorteNotificacaoAdmin` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `tipo` ENUM('NOVA_RETIRADA', 'ESTOQUE_BAIXO', 'ESTOQUE_ESGOTADO') NOT NULL,
    `titulo` VARCHAR(160) NOT NULL,
    `mensagem` TEXT NOT NULL,
    `ganhadorId` INTEGER NULL,
    `premioId` INTEGER NULL,
    `lidaEm` DATETIME(3) NULL,
    `lidaPorId` INTEGER NULL,
    `lidaPorNome` VARCHAR(150) NULL,
    `emailDestinatarios` VARCHAR(500) NULL,
    `emailEnviadoEm` DATETIME(3) NULL,
    `emailErro` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SorteNotificacaoAdmin_lidaEm_createdAt_idx`(`lidaEm`, `createdAt`),
    INDEX `SorteNotificacaoAdmin_baseOrigin_createdAt_idx`(`baseOrigin`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `SorteGanhador_rodadaId_userId_idx` ON `SorteGanhador`(`rodadaId`, `userId`);

-- CreateIndex
CREATE INDEX `SorteGanhador_premioId_userId_idx` ON `SorteGanhador`(`premioId`, `userId`);

-- CreateIndex
CREATE INDEX `SortePremio_naLoja_ativo_deletedAt_ordem_idx` ON `SortePremio`(`naLoja`, `ativo`, `deletedAt`, `ordem`);

-- AddForeignKey
ALTER TABLE `SorteGanhador` ADD CONSTRAINT `SorteGanhador_rodadaId_fkey` FOREIGN KEY (`rodadaId`) REFERENCES `SorteRodada`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteMomentoPremiado` ADD CONSTRAINT `SorteMomentoPremiado_campanhaId_fkey` FOREIGN KEY (`campanhaId`) REFERENCES `SorteCampanha`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SorteInscricao` ADD CONSTRAINT `SorteInscricao_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
