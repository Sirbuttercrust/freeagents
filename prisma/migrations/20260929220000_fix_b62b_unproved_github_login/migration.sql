-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "unprovedGithubLogin" TEXT;

-- FIX-B62b: nothing is deleted. Every login stored before logins needed
-- proof moves to "unprovedGithubLogin" and "githubLogin" is cleared, so
-- "githubLogin" holds proved logins only. Every row keeps its DID, its jobs
-- and its login text. This migration cannot tell a row a GitHub sign-in made
-- from a row POST /accounts made (the platform seed that derives a sign-in
-- DID is not in the database), so it demotes every row; the next GitHub
-- sign-in for a login re-proves the one row whose DID that sign-in derives
-- (AccountRepository.promoteUnprovedGithubLogin).
UPDATE "Account" SET "unprovedGithubLogin" = "githubLogin", "githubLogin" = NULL WHERE "githubLogin" IS NOT NULL;
