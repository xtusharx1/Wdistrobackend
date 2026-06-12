const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const User = require('./User');

const Shop = sequelize.define('Shop', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  shop_name: { type: DataTypes.STRING, allowNull: false },
  seller_permit: { type: DataTypes.STRING, allowNull: false, unique: true },
  tobacco_license: { type: DataTypes.STRING, allowNull: true },
  owner_name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  contact_details: { type: DataTypes.STRING, allowNull: false },
  address: { type: DataTypes.STRING, allowNull: true },
  city: { type: DataTypes.STRING, allowNull: true },
  state: { type: DataTypes.STRING, allowNull: true },
  zip: { type: DataTypes.STRING, allowNull: true },
  approved: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  approval_status: {
    type: DataTypes.ENUM('Pending', 'Approved', 'Rejected'),
    defaultValue: 'Pending',
    allowNull: false
  }
}, {
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = Shop;