const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const ProductCollection = sequelize.define('ProductCollection', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false, unique: true },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  tableName: 'ProductCollections',
  indexes: [
    { fields: ['name'] }
  ]
});

module.exports = ProductCollection;
