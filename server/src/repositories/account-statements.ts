import type { db as database } from "../postgres.ts";

export function createAccountStatements({ db, userSelectColumns, authAccountFailureLimit }: {
  db: typeof database;
  userSelectColumns: string;
  authAccountFailureLimit: number;
}) {
const selectUserAuthByUsernameStmt = db.prepare(
  "SELECT id, username, password, role, status, mustChangePassword, failedLoginAttempts, failedLoginWindowStart, lockedUntil, lastLoginAt, createdAt, updatedAt FROM users WHERE username = ? AND role = 'admin'",
);
const selectScorerByUsernameStmt = db.prepare(
  "SELECT id, username, password, role, status, mustChangePassword, failedLoginAttempts, failedLoginWindowStart, lockedUntil, lastLoginAt, createdAt, updatedAt FROM users WHERE username = ? AND role = 'scorer'",
);
const selectUserByUsernameStmt = db.prepare(
  `SELECT ${userSelectColumns} FROM users WHERE username = ?`,
);
const selectUserByIdStmt = db.prepare(
  `SELECT ${userSelectColumns} FROM users WHERE id = ?`,
);
const insertScorerUserStmt = db.prepare(`
  INSERT INTO users (
    id, username, password, role, status, mustChangePassword,
    failedLoginAttempts, failedLoginWindowStart, lockedUntil,
    lastLoginAt, createdAt, updatedAt
  )
  VALUES (
    @id, @username, @password, 'scorer', 'enabled', true,
    0, NULL, NULL, @lastLoginAt, @createdAt, @updatedAt
  )
`);
const updateScorerUserStmt = db.prepare(`
  UPDATE users
  SET password = COALESCE(@password, password),
      mustChangePassword = CASE WHEN @password IS NULL THEN mustChangePassword ELSE true END,
      status = COALESCE(@status, status),
      updatedAt = @updatedAt
  WHERE id = @id
    AND role = 'scorer'
`);
const deleteScorerUserStmt = db.prepare(
  "DELETE FROM users WHERE id = ? AND role = 'scorer'",
);
const selectAssignedTaskCountByScorerStmt = db.prepare(
  "SELECT COUNT(*) AS total FROM rating_tasks WHERE scorer = ? AND status = 'assigned'",
);
const insertSessionStmt = db.prepare(`
  INSERT INTO user_sessions (tokenHash, userId, expiresAt, createdAt, lastSeenAt)
  VALUES (@tokenHash, @userId, @expiresAt, @createdAt, @lastSeenAt)
`);
const selectSessionUserStmt = db.prepare(`
  SELECT users.id, users.username, users.role, users.status, users.mustChangePassword, users.lastLoginAt, users.createdAt, users.updatedAt
  FROM user_sessions
  JOIN users ON users.id = user_sessions.userId
  WHERE user_sessions.tokenHash = ?
    AND user_sessions.expiresAt > ?
`);
const updateSessionSeenStmt = db.prepare(
  "UPDATE user_sessions SET lastSeenAt = ? WHERE tokenHash = ?",
);
const deleteSessionStmt = db.prepare(
  "DELETE FROM user_sessions WHERE tokenHash = ?",
);
const deleteExpiredSessionsStmt = db.prepare(
  "DELETE FROM user_sessions WHERE expiresAt <= ?",
);
const insertAuthLoginAttemptStmt = db.prepare(`
  INSERT INTO auth_login_attempts (id, username, ip, succeeded, createdAt)
  VALUES (@id, @username, @ip, @succeeded, @createdAt)
`);
const selectAuthUsernameFailureCountStmt = db.prepare(`
  SELECT COUNT(*) AS failedCount
  FROM auth_login_attempts
  WHERE username = ?
    AND succeeded = false
    AND createdAt >= ?
`);
const deleteAuthLoginAttemptsForUsernameStmt = db.prepare(
  "DELETE FROM auth_login_attempts WHERE username = ?",
);
const deleteExpiredAuthLoginAttemptsStmt = db.prepare(
  "DELETE FROM auth_login_attempts WHERE createdAt < ?",
);
const updateUserLoginFailureStmt = db.prepare(`
  UPDATE users
  SET failedLoginAttempts = CASE
        WHEN failedLoginWindowStart IS NULL OR failedLoginWindowStart < @windowStart
          THEN 1
        ELSE failedLoginAttempts + 1
      END,
      failedLoginWindowStart = CASE
        WHEN failedLoginWindowStart IS NULL OR failedLoginWindowStart < @windowStart
          THEN @now
        ELSE failedLoginWindowStart
      END,
      lockedUntil = CASE
        WHEN (
          CASE
            WHEN failedLoginWindowStart IS NULL OR failedLoginWindowStart < @windowStart
              THEN 1
            ELSE failedLoginAttempts + 1
          END
        ) >= ${authAccountFailureLimit}
          THEN @lockedUntil
        ELSE lockedUntil
      END,
      updatedAt = @now
  WHERE id = @id
  RETURNING failedLoginAttempts, lockedUntil
`);
const clearUserLoginFailureStmt = db.prepare(`
  UPDATE users
  SET failedLoginAttempts = 0,
      failedLoginWindowStart = NULL,
      lockedUntil = NULL,
      lastLoginAt = @lastLoginAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const updateOwnPasswordStmt = db.prepare(`
  UPDATE users
  SET password = @password,
      mustChangePassword = false,
      failedLoginAttempts = 0,
      failedLoginWindowStart = NULL,
      lockedUntil = NULL,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const insertCaptchaChallengeStmt = db.prepare(`
  INSERT INTO auth_captcha_challenges (id, answerHash, expiresAt, createdAt)
  VALUES (@id, @answerHash, @expiresAt, @createdAt)
`);
const selectCaptchaChallengeStmt = db.prepare(
  "SELECT id, answerHash, expiresAt, usedAt FROM auth_captcha_challenges WHERE id = ?",
);
const markCaptchaChallengeUsedStmt = db.prepare(
  "UPDATE auth_captcha_challenges SET usedAt = ? WHERE id = ? AND usedAt IS NULL",
);
const deleteExpiredCaptchaChallengesStmt = db.prepare(
  "DELETE FROM auth_captcha_challenges WHERE expiresAt <= ? OR usedAt IS NOT NULL",
);
  return {
    selectUserAuthByUsernameStmt,
    selectScorerByUsernameStmt,
    selectUserByUsernameStmt,
    selectUserByIdStmt,
    insertScorerUserStmt,
    updateScorerUserStmt,
    deleteScorerUserStmt,
    selectAssignedTaskCountByScorerStmt,
    insertSessionStmt,
    selectSessionUserStmt,
    updateSessionSeenStmt,
    deleteSessionStmt,
    deleteExpiredSessionsStmt,
    insertAuthLoginAttemptStmt,
    selectAuthUsernameFailureCountStmt,
    deleteAuthLoginAttemptsForUsernameStmt,
    deleteExpiredAuthLoginAttemptsStmt,
    updateUserLoginFailureStmt,
    clearUserLoginFailureStmt,
    updateOwnPasswordStmt,
    insertCaptchaChallengeStmt,
    selectCaptchaChallengeStmt,
    markCaptchaChallengeUsedStmt,
    deleteExpiredCaptchaChallengesStmt,
  };
}
