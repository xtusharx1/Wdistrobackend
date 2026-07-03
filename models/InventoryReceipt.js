const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');

const InventoryReceipt = sequelize.define('InventoryReceipt', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  receipt_number: { type: DataTypes.STRING, allowNull: false, unique: true },
  invoice_url: { type: DataTypes.STRING, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  received_by_user_id: {
    type: DataTypes.INTEGER,
    references: {
      model: User,
      key: 'id'
    },
    allowNull: false
  }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  tableName: 'InventoryReceipts',
  indexes: [
    { fields: ['received_by_user_id'] },
    { fields: ['receipt_number'] }
  ]
});

module.exports = InventoryReceipt;
