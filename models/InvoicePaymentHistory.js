const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const InvoicePaymentHistory = sequelize.define('InvoicePaymentHistory', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  invoice_id: { type: DataTypes.INTEGER, allowNull: false },
  payment_method: {
    type: DataTypes.ENUM('Cash', 'Card', 'Check', 'MO', 'Adjusted'),
    allowNull: false
  },
  payment_amount: { type: DataTypes.FLOAT, allowNull: false },
  payment_reference_no: { type: DataTypes.STRING, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  verified_by_user_id: { type: DataTypes.INTEGER, allowNull: true },
  verified_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [{ fields: ['invoice_id'] }]
});

module.exports = InvoicePaymentHistory;
