-- CreateTable
CREATE TABLE `ClubgasErroLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `userDocumento` VARCHAR(20) NULL,
    `baseOrigin` VARCHAR(50) NULL,
    `operacao` VARCHAR(30) NOT NULL,
    `origem` VARCHAR(20) NOT NULL,
    `chassi` VARCHAR(100) NULL,
    `placa` VARCHAR(20) NULL,
    `categoria` VARCHAR(30) NOT NULL,
    `httpStatus` INTEGER NULL,
    `mensagem` VARCHAR(500) NOT NULL,
    `resposta` JSON NULL,
    `duracaoMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ClubgasErroLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `ClubgasErroLog_categoria_createdAt_idx`(`categoria`, `createdAt`),
    INDEX `ClubgasErroLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
