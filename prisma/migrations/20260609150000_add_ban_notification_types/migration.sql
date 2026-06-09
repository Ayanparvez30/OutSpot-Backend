-- Add per-space ban / unban notification types (item 10).
-- MySQL stores Prisma enums as inline TEXT/ENUM on the column itself, so we
-- extend the column's enum list. Existing rows keep their values unchanged.

ALTER TABLE `Notification`
  MODIFY COLUMN `type` ENUM(
    'FRIEND_ACCEPTED',
    'FRIEND_REQUEST',
    'NEW_CHALLENGE',
    'DAILY_CHALLENGE',
    'WEEKLY_CHALLENGE',
    'COMMUNITY_BANNED',
    'COMMUNITY_UNBANNED',
    'GROUP_BANNED',
    'GROUP_UNBANNED'
  ) NOT NULL;
