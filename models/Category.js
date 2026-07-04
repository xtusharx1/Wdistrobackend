const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Category = sequelize.define('Category', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  category_name: { type: DataTypes.STRING, allowNull: false, unique: true },
  sub_categories: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [], allowNull: false },
  display_order: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  tableName: 'Categories',
  indexes: [
    { fields: ['category_name'] },
    { fields: ['display_order'] }
  ]
});

module.exports = Category;
