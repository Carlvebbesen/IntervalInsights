// Phase 3 backfill: populate `email` / `name` / `email_verified` on existing
// `users` rows from Clerk, keyed by `clerk_id`. Single-table model — these rows
// already ARE Better Auth users, they just lack an email to sign in with. An
// OTP sign-in matches a backfilled row by (lowercased) email, landing the user
// on their existing data (same users.id, same activities).
//
// Only VERIFIED Clerk addresses are written (same mailbox-capture reasoning as
// `fetchClerkIdentity` in auth_middleware.ts — an unverified address must never
// become the OTP match key). Emails are lowercased (Better Auth lowercases on
// sign-in match). Name falls back to the email local-part (same rule as the
// authGuard create-hook). Idempotent and re-runnable — run it periodically
// during the dual-auth window and once right before the Phase 6 cutover to
// close the dual-window identity gap. DRY_RUN=1 reports without writing.
//
//   DRY_RUN=1 bun run scripts/backfill_user_emails.ts   # preview
//   bun run scripts/backfill_user_emails.ts             # write

import { createClerkClient } from "@clerk/backend";
import { sleep } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/schema";
import { type InsertUser, users } from "../src/schema";
import { runScript } from "./_harness";

const DRY_RUN = process.env.DRY_RUN === "1";
const DELAY_MS = Number(process.env.DELAY_MS ?? 100);
const PAGE_SIZE = 100;

for (const required of ["DATABASE_URL", "CLERK_SECRET_KEY"]) {
  if (!process.env[required]) {
    console.error(`${required} is required`);
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

type ClerkUser = Awaited<ReturnType<typeof clerkClient.users.getUser>>;

const isVerified = (a?: { verification?: { status?: string } | null } | null) =>
  a?.verification?.status === "verified";

// Verified primary address wins; otherwise the first verified address. Mirrors
// fetchClerkIdentity so the backfill and the live lazy-create agree on identity.
function resolveIdentity(clerkUser: ClerkUser): { email: string | null; name: string | null } {
  const primary = clerkUser.primaryEmailAddress;
  const address = isVerified(primary)
    ? primary
    : (clerkUser.emailAddresses?.find(isVerified) ?? null);
  const email = address?.emailAddress?.toLowerCase() ?? null;
  const clerkName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || null;
  const name = clerkName ?? (email ? (email.split("@")[0] ?? null) : null);
  return { email, name };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

async function main() {
  console.log(`[backfill_user_emails] dryRun=${DRY_RUN} delay=${DELAY_MS}ms`);

  let offset = 0;
  let total = 0;
  let updated = 0;
  let alreadyCurrent = 0;
  let noVerifiedEmail = 0;
  let missingDbUser = 0;
  let collisions = 0;
  let errors = 0;

  for (;;) {
    const page = await clerkClient.users.getUserList({
      limit: PAGE_SIZE,
      offset,
      orderBy: "+created_at",
    });

    for (const clerkUser of page.data) {
      total += 1;
      try {
        const { email, name } = resolveIdentity(clerkUser);
        if (!email) {
          noVerifiedEmail += 1;
          console.warn(`[backfill] clerk=${clerkUser.id} has no verified email — skipping`);
          await sleep(DELAY_MS);
          continue;
        }

        const dbUser = await db.query.users.findFirst({
          where: eq(users.clerkId, clerkUser.id),
        });
        if (!dbUser) {
          missingDbUser += 1;
          console.warn(`[backfill] clerk=${clerkUser.id} has no users row — skipping`);
          await sleep(DELAY_MS);
          continue;
        }

        const updates: Partial<InsertUser> = {};
        const changes: string[] = [];
        if (dbUser.email !== email) {
          updates.email = email;
          changes.push(`email ${dbUser.email} -> ${email}`);
        }
        // Only fill a missing name — never overwrite a name the user set themselves.
        if (!dbUser.name && name) {
          updates.name = name;
          changes.push(`name ${dbUser.name} -> ${name}`);
        }
        if (!dbUser.emailVerified) {
          updates.emailVerified = true;
          changes.push("emailVerified -> true");
        }

        if (changes.length === 0) {
          alreadyCurrent += 1;
          await sleep(DELAY_MS);
          continue;
        }

        console.log(`[backfill] clerk=${clerkUser.id} user=${dbUser.id}: ${changes.join(", ")}`);
        if (!DRY_RUN) {
          try {
            await db.update(users).set(updates).where(eq(users.id, dbUser.id));
            updated += 1;
          } catch (err) {
            if (isUniqueViolation(err)) {
              collisions += 1;
              console.error(
                `[backfill] clerk=${clerkUser.id} email=${email} COLLISION — ` +
                  "already owned by another users row; leaving row unchanged",
              );
            } else {
              throw err;
            }
          }
        } else {
          updated += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(`[backfill] clerk=${clerkUser.id} failed:`, err);
      }
      await sleep(DELAY_MS);
    }

    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) break;
  }

  console.log(
    `[backfill_user_emails] done. total=${total} updated=${updated} ` +
      `alreadyCurrent=${alreadyCurrent} noVerifiedEmail=${noVerifiedEmail} ` +
      `missingDbUser=${missingDbUser} collisions=${collisions} errors=${errors}`,
  );
}

runScript({ name: "backfill_user_emails", once: false, db, pool }, main);
