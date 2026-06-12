const User = require('./User');
const Shop = require('./Shop');
const Product = require('./Product');
const Order = require('./Order');
const OrderItem = require('./OrderItem');
const Invoice = require('./Invoice');
const SalesExecutiveAssignment = require('./SalesExecutiveAssignment');



// 3. Sales Executive Assignment & Shop / User
SalesExecutiveAssignment.belongsTo(User, { as: 'SalesExecutive', foreignKey: 'sales_exec_id' });
SalesExecutiveAssignment.belongsTo(Shop, { foreignKey: 'shop_id' });
Shop.hasMany(SalesExecutiveAssignment, { foreignKey: 'shop_id' });
User.hasMany(SalesExecutiveAssignment, { foreignKey: 'sales_exec_id' });


// 5. Order & Shop
Order.belongsTo(Shop, { foreignKey: 'shop_id' });
Shop.hasMany(Order, { foreignKey: 'shop_id' });

// 6. Order & OrderItem & Product
Order.hasMany(OrderItem, { foreignKey: 'order_id' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id' });
Product.hasMany(OrderItem, { foreignKey: 'product_id' });

// 7. Invoice & Order
Invoice.belongsTo(Order, { foreignKey: 'order_id' });
Order.hasOne(Invoice, { foreignKey: 'order_id' });

module.exports = {
  User,
  Shop,
  Product,
  Order,
  OrderItem,
  Invoice,
  SalesExecutiveAssignment
};
