const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const InventoryReceipt = require('./InventoryReceipt');
const Product = require('./Product');

const InventoryReceiptItem = sequelize.define('InventoryReceiptItem', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  inventory_receipt_id: {
    type: DataTypes.INTEGER,
    references: {
      model: InventoryReceipt,
      key: 'id'
    },
    allowNull: false
  },
  product_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Product,
      key: 'id'
    },
    allowNull: false
  },
  quantity_received: { type: DataTypes.INTEGER, allowNull: false }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  tableName: 'InventoryReceiptItems',
  indexes: [
    { fields: ['inventory_receipt_id'] },
    { fields: ['product_id'] }
  ]
});

module.exports = InventoryReceiptItem;
