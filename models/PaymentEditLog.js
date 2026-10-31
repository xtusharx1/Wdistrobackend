const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// Audit trail for edits to InvoicePaymentHistory rows (mirrors OrderEditLog)
const PaymentEditLog = sequelize.define('PaymentEditLog', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  payment_id: { type: DataTypes.INTEGER, allowNull: false },
  invoice_id: { type: DataTypes.INTEGER, allowNull: false },
  user_id: { type: DataTypes.INTEGER, allowNull: true },
  previous_value: { type: DataTypes.JSON, allowNull: false },
  new_value: { type: DataTypes.JSON, allowNull: false },
  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,
  indexes: [
    { fields: ['payment_id'] },
    { fields: ['invoice_id'] }
  ]
});

module.exports = PaymentEditLog;
