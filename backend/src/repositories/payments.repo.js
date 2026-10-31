'use strict';

const { NOW_UTC } = require('../db/openPostgres');

/** SQL for payment_settings / payment_orders. Nothing here decides policy; payments/paymentService.js does. Async, PostgreSQL. */
function createPaymentsRepository(db) {
  const one = async (sql, values = []) => (await db.query(sql, values)).rows[0] || null;
  return {
    getSettings: () => one('SELECT mode, access_enabled, amount_minor, currency, provider, updated_by, updated_at FROM payment_settings WHERE id = 1'),
    async saveSettings({ mode, accessEnabled, amountMinor, currency, updatedBy }) {
      await db.query(
        `UPDATE payment_settings SET mode = $1, access_enabled = $2, amount_minor = $3,
                currency = $4, updated_by = $5, updated_at = ${NOW_UTC} WHERE id = 1`,
        [mode, accessEnabled ? 1 : 0, amountMinor, currency, updatedBy || null]
      );
    },
    insertOrder(order) {
      return one(
        `INSERT INTO payment_orders
           (id, user_id, protocol_id, protocol_version_id, amount_minor, currency, status, mode, provider, provider_order_id, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [order.id, order.userId ?? null, order.protocolId, order.versionId, order.amountMinor, order.currency,
          order.status, order.mode, order.provider, order.providerOrderId ?? null, order.completedAt ?? null]
      );
    },
    getOrder: (id) => one('SELECT * FROM payment_orders WHERE id = $1', [id]),
    updateOrder(id, { status, providerPaymentId, providerReference, completed }) {
      return one(
        `UPDATE payment_orders SET status = $1,
                provider_payment_id = COALESCE($2, provider_payment_id),
                provider_reference = COALESCE($3, provider_reference),
                updated_at = ${NOW_UTC},
                completed_at = CASE WHEN $4::boolean THEN ${NOW_UTC} ELSE completed_at END
          WHERE id = $5 RETURNING *`,
        [status, providerPaymentId || null, providerReference || null, Boolean(completed), id]
      );
    },
    async countOrders() {
      const row = await one('SELECT COUNT(*)::integer AS n FROM payment_orders');
      return row.n;
    },
    /** The slug of a protocol only while it is currently published (access is re-checked against this). */
    async findPublishedSlug(protocolId) {
      const row = await one("SELECT slug FROM protocols WHERE id = $1 AND status = 'published'", [protocolId]);
      return row ? row.slug : null;
    },
  };
}

module.exports = { createPaymentsRepository };
