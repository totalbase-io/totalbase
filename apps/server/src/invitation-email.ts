import { TotalBaseError } from "@totalbase/errors";
import type { InvitationDetails } from "@totalbase/auth";
import { MAX_INVITATION_MESSAGE_LENGTH } from "@totalbase/settings";
import type { AppContext } from "./context.js";

/**
 * An invitation's `message` (Security.md §2.9): the caller's own line for the email, plain text. It reaches
 * the email only where the administrator's template says `{{message}}`. Checked before anything is written.
 */
export function parseInvitationMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_INVITATION_MESSAGE_LENGTH) {
    throw new TotalBaseError("INVALID_QUERY", `message must be text of at most ${MAX_INVITATION_MESSAGE_LENGTH} characters.`);
  }
  return value;
}

/**
 * What an invitation's email says about who invites and as what: the inviter (the user a backend acts for,
 * else the caller), and the invited account's roles by name, as they are when the email is sent.
 */
export async function invitationDetails(
  context: AppContext,
  inviterId: string | undefined,
  userId: string,
  message: string | undefined,
): Promise<InvitationDetails> {
  const [inviter, roleIds] = await Promise.all([
    inviterId ? context.auth.users.findById(inviterId) : null,
    context.roleAssignments.listRolesForUser(userId),
  ]);
  const roles = (await Promise.all(roleIds.map((id) => context.roles.findById(id)))).flatMap((role) => (role ? [role.name] : [])).sort();
  return { ...(inviter && { inviter: { name: inviter.name, email: inviter.email } }), roles, message };
}
