-- AlterTable: per-user "disappear on exit" pointer. Additive, non-destructive.
-- Messages with id <= clearedUpToMessageId are hidden from this user only.
ALTER TABLE `UserOnChat` ADD COLUMN `clearedUpToMessageId` INTEGER NOT NULL DEFAULT 0;
