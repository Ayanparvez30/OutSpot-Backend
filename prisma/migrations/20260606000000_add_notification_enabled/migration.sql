-- AlterTable: master notification switch. Additive, non-destructive.
-- Existing rows default to TRUE (notifications on), matching schema @default(true).
ALTER TABLE `User` ADD COLUMN `notificationEnabled` BOOLEAN NOT NULL DEFAULT true;
