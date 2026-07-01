const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const ProductVariationGroup = sequelize.define('ProductVariationGroup', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  group_name: { type: DataTypes.STRING, allowNull: false },
  product_ids: {
    type: DataTypes.ARRAY(DataTypes.INTEGER),
    allowNull: false,
    defaultValue: [],
  },
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['group_name'] },
  ],
});

module.exports = ProductVariationGroup;
