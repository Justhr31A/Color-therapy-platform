/**
 * Who may manage which protocol. Kept as plain, dependency-free functions so
 * the rule is unit-testable and lives in exactly one place.
 *
 *  - admin  : full protocol-management access (every protocol).
 *  - doctor : only protocols they created (unchanged legacy behaviour).
 *  - anyone else (patients, unauthenticated): none.
 */
function isAdmin(user) {
  return Boolean(user) && user.role === 'admin';
}

function canManageProtocol(user, protocolRow) {
  if (!user || !protocolRow) return false;
  if (isAdmin(user)) return true;
  return user.role === 'doctor' && protocolRow.doctor_id === user.id;
}

module.exports = { isAdmin, canManageProtocol };
