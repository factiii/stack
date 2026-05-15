export function truncateBundle(
  sessions: number[],
  activeId: number,
  maxAccounts: number,
): { kept: number[]; dropped: number[] } {
  if (sessions.length <= maxAccounts) {
    return { kept: sessions, dropped: [] };
  }
  const others = sessions.filter((id) => id !== activeId);
  const keptOthers = maxAccounts > 1 ? others.slice(-(maxAccounts - 1)) : [];
  const kept = [...keptOthers, activeId];
  const keptSet = new Set(kept);
  const dropped = sessions.filter((id) => !keptSet.has(id));
  return { kept, dropped };
}
