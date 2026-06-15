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
  image_url: { type: DataTypes.STRING, allowNull: true }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Product;