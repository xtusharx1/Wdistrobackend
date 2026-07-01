const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const ShopPermit = sequelize.define('ShopPermit', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  shop_id: { type: DataTypes.INTEGER, allowNull: false },
  // STRING instead of ENUM so new permit types need no migration
  permit_type: { type: DataTypes.STRING, allowNull: false },
  document_url: { type: DataTypes.STRING, allowNull: false },
  original_file_name: { type: DataTypes.STRING, allowNull: false },
  uploaded_by: { type: DataTypes.INTEGER, allowNull: false },
  uploaded_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  status: {
    type: DataTypes.ENUM('Pending', 'Approved', 'Rejected'),
    defaultValue: 'Pending',
    allowNull: false
  },
  remarks: { type: DataTypes.TEXT, allowNull: true }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  // Soft deletes — records are never permanently removed
  paranoid: true,
  deletedAt: 'deleted_at',
  tableName: 'ShopPermits',
  indexes: [
    // Partial unique index: one active permit per type per shop.
    // Soft-deleted rows don't count against uniqueness.
    {
      unique: true,
      fields: ['shop_id', 'permit_type'],
      where: { deleted_at: null }
    }
  ]
});

module.exports = ShopPermit;
