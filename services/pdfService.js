const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const PDFDocument = require('pdfkit');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

const generateInvoicePDFBuffer = (order, shop) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      resolve(Buffer.concat(buffers));
    });
    doc.on('error', reject);

    // Document header
    doc.fontSize(20).text('INVOICE', { align: 'right' });
    doc.moveDown();
    doc.fontSize(10).text(`Invoice Number: INV-${order.id}`, { align: 'right' });
    doc.text(`Invoice Date: ${new Date().toLocaleDateString('en-US')}`, { align: 'right' });
    doc.text(`Order ID: WS-${order.id}`, { align: 'right' });

    // Bill To section
    doc.fontSize(12).text('Bill To:', { underline: true });
    doc.fontSize(10).text(`Shop: ${shop.shop_name}`);
    doc.text(`Owner: ${shop.owner_name}`);
    doc.text(`Email: ${shop.email}`);
    doc.text(`Contact: ${shop.contact_details || 'N/A'}`);
    doc.text(`Address: ${[shop.address, shop.city, shop.state, shop.zip].filter(Boolean).join(', ') || 'N/A'}`);
    doc.moveDown(2);

    // Table Header
    const tableTop = 220;
    doc.fontSize(10);
    doc.text('Item Description', 50, tableTop);
    doc.text('Req Qty', 250, tableTop, { width: 50, align: 'right' });
    doc.text('App Qty', 300, tableTop, { width: 50, align: 'right' });
    doc.text('Price ($)', 350, tableTop, { width: 70, align: 'right' });
    doc.text('Total ($)', 430, tableTop, { width: 70, align: 'right' });

    let position = tableTop + 20;
    (order.OrderItems || []).forEach(item => {
      const name = item.Product?.name || `Product #${item.product_id}`;
      const reqQty = item.requested_qty;
      const appQty = item.approved_qty ?? reqQty;
      const price = item.price;
      const total = price * appQty;

      doc.text(name, 50, position);
      doc.text(String(reqQty), 250, position, { width: 50, align: 'right' });
      doc.text(String(appQty), 300, position, { width: 50, align: 'right' });
      doc.text(`$${price.toFixed(2)}`, 350, position, { width: 70, align: 'right' });
      doc.text(`$${total.toFixed(2)}`, 430, position, { width: 70, align: 'right' });

      position += 20;
    });

    // Grand Total
    doc.moveDown(2);
    doc.fontSize(14).text(`Grand Total: $${order.total_amount.toFixed(2)}`, { align: 'right' });

    doc.end();
  });
};

const uploadInvoicePDF = async (order, shop) => {
  const buffer = await generateInvoicePDFBuffer(order, shop);
  const key = `invoices/invoice-${order.id}-${Date.now()}.pdf`;
  const bucket = process.env.AWS_S3_BUCKET || 'wdistro';
  
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  }));

  return `https://${bucket}.s3.${process.env.AWS_REGION || 'us-west-1'}.amazonaws.com/${key}`;
};

module.exports = {
  uploadInvoicePDF,
};
