const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Order = require('./Order');

const Invoice = sequelize.define('Invoice', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  order_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Order,
      key: 'id'
    },
    allowNull: false
  },
  final_amount: { type: DataTypes.FLOAT, allowNull: false },
  shipping_charge: { type: DataTypes.FLOAT, defaultValue: 0.0, allowNull: false },
  generated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, allowNull: false },
  pdf_url: { type: DataTypes.STRING, allowNull: true }
}, {
  timestamps: false,
  indexes: [
    { fields: ['order_id'] }
  ]
});

module.exports = Invoice;