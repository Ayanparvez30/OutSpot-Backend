-- Chat moderation & message-feature baseline.
-- All changes are additive: new columns are nullable or have safe defaults,
-- new tables stand alone. Existing rows back-fill via defaults and existing
-- queries keep working unchanged.

-- ---------------------------------------------------------------
-- 1) Message: reply / quote + forwarded flag
-- ---------------------------------------------------------------
ALTER TABLE `Message`
  ADD COLUMN `replyToMessageId` INT NULL,
  ADD COLUMN `forwarded`        BOOLEAN NOT NULL DEFAULT false;

-- SetNull on parent-delete keeps replies as "reply to deleted message" instead
-- of cascading and wiping legitimate child rows.
ALTER TABLE `Message`
  ADD CONSTRAINT `Message_replyToMessageId_fkey`
    FOREIGN KEY (`replyToMessageId`) REFERENCES `Message`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `Message_replyToMessageId_idx` ON `Message`(`replyToMessageId`);

-- ---------------------------------------------------------------
-- 2) Report: extend additively. Existing rows default to type="user".
-- ---------------------------------------------------------------
ALTER TABLE `Report`
  ADD COLUMN `type`        VARCHAR(191) NOT NULL DEFAULT 'user',
  ADD COLUMN `messageId`   INT NULL,
  ADD COLUMN `chatId`      INT NULL,
  ADD COLUMN `contextType` VARCHAR(191) NULL,
  ADD COLUMN `communityId` INT NULL,
  ADD COLUMN `note`        TEXT NULL;

-- SetNull on message-delete preserves the report audit row when an admin
-- deletes the offending message.
ALTER TABLE `Report`
  ADD CONSTRAINT `Report_messageId_fkey`
    FOREIGN KEY (`messageId`) REFERENCES `Message`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `Report_type_status_idx` ON `Report`(`type`, `status`);
CREATE INDEX `Report_messageId_idx`   ON `Report`(`messageId`);

-- ---------------------------------------------------------------
-- 3) CommunityBan — per-community ban, distinct from global User.isBanned.
-- ---------------------------------------------------------------
CREATE TABLE `CommunityBan` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `communityId` INT NOT NULL,
  `userId`      INT NOT NULL,
  `bannedById`  INT NOT NULL,
  `reason`      VARCHAR(191) NULL,
  `bannedAt`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CommunityBan_communityId_userId_key` (`communityId`, `userId`),
  INDEX `CommunityBan_userId_idx` (`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CommunityBan`
  ADD CONSTRAINT `CommunityBan_communityId_fkey`
    FOREIGN KEY (`communityId`) REFERENCES `Community`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CommunityBan_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `CommunityBan_bannedById_fkey`
    FOREIGN KEY (`bannedById`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------
-- 4) ChatBan — per-group-chat ban (mirror of CommunityBan).
-- ---------------------------------------------------------------
CREATE TABLE `ChatBan` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `chatId`     INT NOT NULL,
  `userId`     INT NOT NULL,
  `bannedById` INT NOT NULL,
  `reason`     VARCHAR(191) NULL,
  `bannedAt`   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `ChatBan_chatId_userId_key` (`chatId`, `userId`),
  INDEX `ChatBan_userId_idx` (`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ChatBan`
  ADD CONSTRAINT `ChatBan_chatId_fkey`
    FOREIGN KEY (`chatId`) REFERENCES `Chat`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ChatBan_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `ChatBan_bannedById_fkey`
    FOREIGN KEY (`bannedById`) REFERENCES `User`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
