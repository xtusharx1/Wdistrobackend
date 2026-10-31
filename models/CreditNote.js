const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Credit issued for an approved return; never alters the original invoice total
const CreditNote = sequelize.define('CreditNote', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  credit_note_number: { type: DataTypes.STRING(50), allowNull: false, unique: true },
  return_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  order_id: { type: DataTypes.INTEGER, allowNull: false },
  invoice_id: { type: DataTypes.INTEGER, allowNull: false },
  amount: { type: DataTypes.FLOAT, allowNull: false },
  // Sum of CreditNoteApplications; NULL only on notes issued before usage tracking (backfilled at startup)
  used_amount: { type: DataTypes.FLOAT, allowNull: true },
  status: {
    type: DataTypes.ENUM('issued'),
    defaultValue: 'issued',
    allowNull: false
  },
  pdf_url: { type: DataTypes.STRING, allowNull: true },
  issued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  created_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
}, {
  timestamps: false,
  indexes: [
    { fields: ['order_id'] },
    { fields: ['invoice_id'] }
  ]
});

module.exports = CreditNote;
