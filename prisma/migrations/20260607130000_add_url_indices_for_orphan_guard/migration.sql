-- Indices for the orphan-only S3 guard. Each scan does
--    SELECT COUNT(*) FROM <table> WHERE <urlCol> = ?
-- across the 7 user-generated URL columns below. Without these, MySQL would
-- have to full-table-scan at large row counts.
--
-- TEXT columns (User.selfieUrl, Minime.avatarUrl) need a prefix length —
-- MySQL cannot index a TEXT column without one. 191 chars is enough for
-- any S3 URL we generate (typical length < 180).

CREATE INDEX `Story_mediaUrl_idx`         ON `Story`(`mediaUrl`);
CREATE INDEX `LocationPoint_mediaUrl_idx` ON `LocationPoint`(`mediaUrl`);
CREATE INDEX `Submission_mediaUrl_idx`    ON `Submission`(`mediaUrl`);
CREATE INDEX `Message_imageUrl_idx`       ON `Message`(`imageUrl`);
CREATE INDEX `ChatImage_fileUrl_idx`      ON `ChatImage`(`fileUrl`);
CREATE INDEX `User_selfieUrl_idx`         ON `User`(`selfieUrl`(191));
CREATE INDEX `User_bodyShapeUrl_idx`      ON `User`(`bodyShapeUrl`);
CREATE INDEX `Minime_avatarUrl_idx`       ON `Minime`(`avatarUrl`(191));
CREATE INDEX `Minime_selfieUrl_idx`       ON `Minime`(`selfieUrl`);
