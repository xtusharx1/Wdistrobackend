const User = require('./User');
const Shop = require('./Shop');
const Product = require('./Product');
const Order = require('./Order');
const OrderItem = require('./OrderItem');
const Invoice = require('./Invoice');
const InvoicePaymentHistory = require('./InvoicePaymentHistory');
const SalesExecutiveAssignment = require('./SalesExecutiveAssignment');
const StockMovement = require('./StockMovement');
const ShopPermit = require('./ShopPermit');
const OrderEditLog = require('./OrderEditLog');
const DraftOrder = require('./DraftOrder');
const DraftOrderItem = require('./DraftOrderItem');
const ProductVariationGroup = require('./ProductVariationGroup');



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

// 7a. InvoicePaymentHistory & Invoice & User
Invoice.hasMany(InvoicePaymentHistory, { foreignKey: 'invoice_id', as: 'PaymentHistory' });
InvoicePaymentHistory.belongsTo(Invoice, { foreignKey: 'invoice_id' });
InvoicePaymentHistory.belongsTo(User, { foreignKey: 'verified_by_user_id', as: 'VerifiedBy' });
User.hasMany(InvoicePaymentHistory, { foreignKey: 'verified_by_user_id' });

// 8. StockMovement associations
StockMovement.belongsTo(Product, { foreignKey: 'product_id' });
Product.hasMany(StockMovement, { foreignKey: 'product_id' });
StockMovement.belongsTo(Order, { foreignKey: 'order_id' });
Order.hasMany(StockMovement, { foreignKey: 'order_id' });

// 9. ShopPermit associations
ShopPermit.belongsTo(Shop, { foreignKey: 'shop_id' });
Shop.hasMany(ShopPermit, { foreignKey: 'shop_id', as: 'permits' });

// 10. OrderEditLog associations
OrderEditLog.belongsTo(Order, { foreignKey: 'order_id' });
Order.hasMany(OrderEditLog, { foreignKey: 'order_id' });

// 11. DraftOrder associations
DraftOrder.belongsTo(Shop, { foreignKey: 'shop_id' });
Shop.hasMany(DraftOrder, { foreignKey: 'shop_id' });
DraftOrder.hasMany(DraftOrderItem, { foreignKey: 'draft_order_id' });
DraftOrderItem.belongsTo(DraftOrder, { foreignKey: 'draft_order_id' });
DraftOrderItem.belongsTo(Product, { foreignKey: 'product_id' });
Product.hasMany(DraftOrderItem, { foreignKey: 'product_id' });

module.exports = {
  User,
  Shop,
  Product,
  Order,
  OrderItem,
  Invoice,
  InvoicePaymentHistory,
  SalesExecutiveAssignment,
  StockMovement,
  ShopPermit,
  OrderEditLog,
  DraftOrder,
  DraftOrderItem,
  ProductVariationGroup,
};
