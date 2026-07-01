const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Product = sequelize.define('Product', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  sku_id: { type: DataTypes.STRING, allowNull: true },
  price: { type: DataTypes.FLOAT, allowNull: false },
  purchase_cost: { type: DataTypes.FLOAT, allowNull: true },
  category: { type: DataTypes.STRING, defaultValue: 'General', allowNull: false },
  main_category: { type: DataTypes.STRING, defaultValue: 'General Merchandise', allowNull: false },
  sub_category: { type: DataTypes.STRING, defaultValue: 'Misc', allowNull: false },
  required_license: { type: DataTypes.STRING, defaultValue: 'Seller Permit', allowNull: false },
  stock_quantity: { type: DataTypes.INTEGER, allowNull: false },
  image_url: { type: DataTypes.STRING, allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: true },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false },
  is_clearance: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  clearance_price: { type: DataTypes.FLOAT, allowNull: true },
  is_featured: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  featured_order: { type: DataTypes.INTEGER, allowNull: true }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['main_category'] },
    { fields: ['sub_category'] },
    { fields: ['sku_id'] },
    { fields: ['is_featured'] }
  ]
});

module.exports = Product;