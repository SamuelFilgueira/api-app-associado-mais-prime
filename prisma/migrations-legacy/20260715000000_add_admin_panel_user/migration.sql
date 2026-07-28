-- CreateTable
CREATE TABLE `AdminPanelUser` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(150) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `email` VARCHAR(150) NOT NULL,
  `role` ENUM('REVISTORIA', 'EVENTOS', 'MARKETING', 'COBRANCA', 'ADMIN') NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `AdminPanelUser_email_key`(`email`),
  INDEX `AdminPanelUser_role_idx`(`role`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
