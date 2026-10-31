/** Label a limit snapshot by the identity it actually proves: configured account or local host. */
export function limitSubjectLabel(snapshot: { account?: string; host: string }): string {
  if (snapshot.account === undefined) return `Host ${snapshot.host}`;
  return snapshot.account.trim().length > 0
    ? `Account ${snapshot.account}`
    : `Account ID missing · observed on Host ${snapshot.host}`;
}
