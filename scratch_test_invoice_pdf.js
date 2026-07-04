require('dotenv').config();
const { Order, Shop, Product, OrderItem } = require('./models');
const { uploadInvoicePDF } = require('./services/pdfService');

async function test() {
  try {
    const order = await Order.findOne({
      include: [
        { model: Shop },
        { model: OrderItem, include: [Product] }
      ]
    });
    if (!order) {
      console.log('No order found to test PDF generation.');
      process.exit(0);
    }
    const shop = order.Shop;
    if (!shop) {
      console.log('Order does not have an associated shop.');
      process.exit(0);
    }
    console.log(`Found Order ID: ${order.id}, Shop: ${shop.shop_name}`);
    console.log('Generating and uploading PDF...');
    const url = await uploadInvoicePDF(order, shop);
    console.log('SUCCESS! Generated Invoice URL:', url);
    process.exit(0);
  } catch (err) {
    console.error('ERROR during testing:', err);
    process.exit(1);
  }
}

test();
