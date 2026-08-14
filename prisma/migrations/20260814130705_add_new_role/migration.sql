-- DropIndex
DROP INDEX `AppVersionPolicy_platform_active_idx` ON `AppVersionPolicy`;

-- DropIndex
DROP INDEX `AppVersionValidationLog_createdAt_idx` ON `AppVersionValidationLog`;

-- DropIndex
DROP INDEX `NotificationPopup_active_createdAt_idx` ON `NotificationPopup`;

-- AlterTable
ALTER TABLE `AdminPanelUser` MODIFY `role` ENUM('REVISTORIA', 'EVENTOS', 'MARKETING', 'COBRANCA', 'ADMIN', 'RESET_PASSWORD') NOT NULL;

-- CreateIndex
CREATE INDEX `AppVersionPolicy_platform_active_idx` ON `AppVersionPolicy`(`platform`, `isActive`, `effectiveFrom` DESC);

-- CreateIndex
CREATE INDEX `AppVersionValidationLog_createdAt_idx` ON `AppVersionValidationLog`(`createdAt` DESC);

-- CreateIndex
CREATE INDEX `NotificationPopup_active_createdAt_idx` ON `NotificationPopup`(`active`, `createdAt` DESC);
