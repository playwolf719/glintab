import type { TaskSnapshot } from '../../types';

export function isCurrentSnapshot(
  current: TaskSnapshot | null,
  incoming: TaskSnapshot,
  requestedStream: string | null,
): boolean {
  if (requestedStream && requestedStream !== incoming.streamId) return false;
  if (!current) return true;
  if (current.streamId === incoming.streamId) return incoming.sequence >= current.sequence;
  return incoming.startedAt > current.startedAt;
}
