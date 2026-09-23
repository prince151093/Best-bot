// Locked voice-channel access manager.
// Locks are kept in memory and reset when the bot restarts.

const locks = new Map(); // guildId -> { channelId, ownerId, allowed: Set<string> }

function key(guildId) {
  return guildId;
}

function getLock(guildId) {
  return locks.get(key(guildId)) || null;
}

function isLocked(guildId, channelId) {
  const lock = getLock(guildId);
  return !!lock && lock.channelId === channelId;
}

function lockChannel(guildId, channelId, allowedUserIds, ownerId) {
  const allowed = new Set(allowedUserIds);
  allowed.add(ownerId);
  locks.set(key(guildId), { channelId, ownerId, allowed });
  return locks.get(key(guildId));
}

function unlockChannel(guildId, channelId) {
  const lock = getLock(guildId);
  if (!lock || lock.channelId !== channelId) return false;
  locks.delete(key(guildId));
  return true;
}

function grantAccess(guildId, channelId, userId) {
  const lock = getLock(guildId);
  if (!lock || lock.channelId !== channelId) return false;
  lock.allowed.add(userId);
  return true;
}

function revokeAccess(guildId, channelId, userId) {
  const lock = getLock(guildId);
  if (!lock || lock.channelId !== channelId) return false;
  if (lock.ownerId === userId) return false;
  lock.allowed.delete(userId);
  return true;
}

function hasAccess(guildId, channelId, userId) {
  const lock = getLock(guildId);
  if (!lock || lock.channelId !== channelId) return true;
  return lock.allowed.has(userId);
}

function getAllowedUserIds(guildId, channelId) {
  const lock = getLock(guildId);
  if (!lock || lock.channelId !== channelId) return [];
  return [...lock.allowed];
}

module.exports = {
  getLock,
  isLocked,
  lockChannel,
  unlockChannel,
  grantAccess,
  revokeAccess,
  hasAccess,
  getAllowedUserIds
};
