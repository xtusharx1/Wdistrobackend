const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Order = require('./Order');

const Invoice = sequelize.define('Invoice', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  order_id: {
    type: DataTypes.INTEGER,
    references: { model: Order, key: 'id' },
    allowNull: false
  },
  final_amount: { type: DataTypes.FLOAT, allowNull: false },
  generated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false },
  pdf_url: { type: DataTypes.STRING, allowNull: true },
  payment_status: {
    type: DataTypes.ENUM('unsettled', 'partially_paid', 'paid', 'settled'),
    defaultValue: 'unsettled',
    allowNull: false
  },
  total_paid_amount: { type: DataTypes.FLOAT, defaultValue: 0, allowNull: false },
  remaining_balance: { type: DataTypes.FLOAT, allowNull: true },
}, {
  timestamps: false,
  indexes: [{ fields: ['order_id'] }]
});

module.exports = Invoice;
