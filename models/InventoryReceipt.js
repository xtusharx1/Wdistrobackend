const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');

const InventoryReceipt = sequelize.define('InventoryReceipt', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  receipt_number: { type: DataTypes.STRING, allowNull: false, unique: true },
  // Manually entered vendor / supplier name (free text)
  vendor_name: { type: DataTypes.STRING(255), allowNull: true },
  // Vendor's own invoice number for traceability and duplicate prevention
  vendor_invoice_number: { type: DataTypes.STRING(255), allowNull: true },
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
    { fields: ['receipt_number'] },
    // Composite unique index prevents entering the same supplier invoice twice.
    // Only enforced when both vendor_name and vendor_invoice_number are provided.
    {
      unique: true,
      fields: ['vendor_name', 'vendor_invoice_number'],
      where: { vendor_invoice_number: { ne: null }, vendor_name: { ne: null } },
      name: 'inventory_receipts_vendor_invoice_unique'
    }
  ]
});

module.exports = InventoryReceipt;
