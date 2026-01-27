-- AlterTable
ALTER TABLE `Challenge` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `isFeatured` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `LocationPoint` ADD COLUMN `placeId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Report` ADD COLUMN `adminNote` VARCHAR(191) NULL,
    ADD COLUMN `reason` VARCHAR(191) NULL,
    ADD COLUMN `reviewedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `banReason` VARCHAR(191) NULL,
    ADD COLUMN `bannedAt` DATETIME(3) NULL,
    ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `isBanned` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `notificationRedDot` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `UserOnChat` ADD COLUMN `isMuted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `mutedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `AdminUser` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'admin',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AdminUser_username_key`(`username`),
    UNIQUE INDEX `AdminUser_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `LocationPoint_userId_createdAt_idx` ON `LocationPoint`(`userId`, `createdAt`);

-- CreateIndex
CREATE INDEX `LocationPoint_userId_placeId_createdAt_idx` ON `LocationPoint`(`userId`, `placeId`, `createdAt`);
