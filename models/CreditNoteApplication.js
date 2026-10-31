const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// One use of a credit note against an invoice. A credit adjustment, never a cash payment.
const CreditNoteApplication = sequelize.define('CreditNoteApplication', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  credit_note_id: { type: DataTypes.INTEGER, allowNull: false },
  invoice_id: { type: DataTypes.INTEGER, allowNull: false },
  shop_id: { type: DataTypes.INTEGER, allowNull: false },
  amount: { type: DataTypes.FLOAT, allowNull: false },
  // return_original: applied to the returned order's own invoice when the credit note was issued
  // manual: applied by an admin to another (usually later) invoice
  source: { type: DataTypes.ENUM('return_original', 'manual'), allowNull: false },
  applied_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
  request_key: { type: DataTypes.STRING(100), allowNull: true, unique: true },
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['credit_note_id'] },
    { fields: ['invoice_id'] },
    { fields: ['shop_id'] }
  ]
});

module.exports = CreditNoteApplication;
