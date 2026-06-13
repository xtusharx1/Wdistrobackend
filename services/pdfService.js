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
    // US Letter page size is 612 x 792 points
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      resolve(Buffer.concat(buffers));
    });
    doc.on('error', reject);

    // 1. Watermark (draw background first)
    doc.save();
    doc.opacity(0.05);
    doc.fillColor('#002d72');
    doc.fontSize(64);
    doc.rotate(-30, { origin: [306, 396] });
    doc.text('W DISTRO', 106, 370, { align: 'center', width: 400 });
    doc.restore();

    // 2. Top Accent Stripe
    doc.rect(0, 0, 612, 10).fill('#002d72');

    // 3. Header Branding
    doc.fillColor('#002d72').fontSize(26).font('Helvetica-Bold').text('W DISTRO', 50, 35);
    doc.fillColor('#64748b').fontSize(10).font('Helvetica-Oblique').text('Premium Wholesale Distributor', 50, 65);

    // 4. Invoice Title & Metadata (Right Aligned)
    doc.fillColor('#1e293b').fontSize(22).font('Helvetica-Bold').text('INVOICE', 400, 35, { align: 'right', width: 162 });
    
    // Invoice Metadata Table on the Right
    const metaY = 75;
    doc.fontSize(9).font('Helvetica');
    doc.fillColor('#64748b').text('Invoice No:', 400, metaY, { width: 70, align: 'left' });
    doc.fillColor('#1e293b').font('Helvetica-Bold').text(`INV-${order.id}`, 470, metaY, { width: 92, align: 'right' });
    
    doc.fillColor('#64748b').font('Helvetica').text('Date:', 400, metaY + 14, { width: 70, align: 'left' });
    const dateVal = order.delivered_at ? new Date(order.delivered_at) : new Date(order.created_at || new Date());
    doc.fillColor('#1e293b').text(dateVal.toLocaleDateString('en-US'), 470, metaY + 14, { width: 92, align: 'right' });
    
    doc.fillColor('#64748b').text('Order ID:', 400, metaY + 28, { width: 70, align: 'left' });
    doc.fillColor('#1e293b').text(`WS-${order.id}`, 470, metaY + 28, { width: 92, align: 'right' });

    // 5. Company Address (Left Aligned below tagline)
    doc.fillColor('#1e293b').fontSize(9).font('Helvetica-Bold').text('W DISTRO INC.', 50, 90);
    doc.font('Helvetica').fillColor('#475569');
    doc.text('123 Distribution Way, Suite 100', 50, 104);
    doc.text('San Francisco, CA 94103', 50, 116);
    doc.text('support@wdistro.com | (800) 555-0199', 50, 128);

    // Divider
    doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, 155).lineTo(562, 155).stroke();

    // 6. Bill To Information
    const billToY = 170;
    doc.fillColor('#002d72').fontSize(10).font('Helvetica-Bold').text('BILL TO', 50, billToY);
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text(shop.shop_name, 50, billToY + 15);
    doc.font('Helvetica').fontSize(9).fillColor('#334155');
    doc.text(`Contact: ${shop.owner_name}`, 50, billToY + 30);
    doc.text(`Phone: ${shop.contact_details || 'N/A'}`, 50, billToY + 42);
    doc.text(`Email: ${shop.email}`, 50, billToY + 54);
    doc.text(`Address: ${[shop.address, shop.city, shop.state, shop.zip].filter(Boolean).join(', ') || 'N/A'}`, 50, billToY + 66, { width: 350 });

    // 7. Itemized Product Table
    const tableTop = 275;
    
    // Draw table header background (dark blue)
    doc.rect(50, tableTop, 512, 22).fill('#002d72');
    
    // Table Header Text
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
    doc.text('Product Name', 60, tableTop + 7, { width: 230 });
    doc.text('Req Qty', 300, tableTop + 7, { width: 60, align: 'right' });
    doc.text('App Qty', 370, tableTop + 7, { width: 60, align: 'right' });
    doc.text('Unit Price', 440, tableTop + 7, { width: 55, align: 'right' });
    doc.text('Total', 505, tableTop + 7, { width: 50, align: 'right' });
    
    let position = tableTop + 22;
    doc.fontSize(9).font('Helvetica');
    
    (order.OrderItems || []).forEach((item, index) => {
      const name = item.Product?.name || `Product #${item.product_id}`;
      const reqQty = item.requested_qty;
      const appQty = item.approved_qty ?? reqQty;
      const price = item.price;
      const total = price * appQty;
      
      // Zebra striping
      doc.fillColor(index % 2 === 0 ? '#f8fafc' : '#ffffff');
      doc.rect(50, position, 512, 22).fill();
      
      // Text drawing
      doc.fillColor('#1e293b');
      doc.text(name, 60, position + 7, { width: 230, ellipsis: true });
      doc.text(String(reqQty), 300, position + 7, { width: 60, align: 'right' });
      doc.text(String(appQty), 370, position + 7, { width: 60, align: 'right' });
      doc.text(`$${price.toFixed(2)}`, 440, position + 7, { width: 55, align: 'right' });
      doc.text(`$${total.toFixed(2)}`, 505, position + 7, { width: 50, align: 'right' });
      
      // Underline border
      doc.strokeColor('#f1f5f9').lineWidth(0.5).moveTo(50, position + 22).lineTo(562, position + 22).stroke();
      
      position += 22;
    });

    // 8. Totals Section
    position += 15;
    doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(350, position).lineTo(562, position).stroke();
    position += 10;
    
    doc.fillColor('#475569').fontSize(10).font('Helvetica-Bold');
    doc.text('Grand Total:', 350, position, { width: 100, align: 'right' });
    doc.fillColor('#002d72').fontSize(14).font('Helvetica-Bold');
    doc.text(`$${order.total_amount.toFixed(2)}`, 450, position - 3, { width: 112, align: 'right' });

    // 9. Footer (at the bottom of the page)
    const footerTop = 720;
    doc.strokeColor('#e2e8f0').lineWidth(1).moveTo(50, footerTop).lineTo(562, footerTop).stroke();
    
    doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('Thank you for your business!', 50, footerTop + 10, { align: 'center', width: 512 });
    
    const genTime = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    doc.fillColor('#cbd5e1').text(`Generated by W DISTRO on ${genTime} (Pacific Time)`, 50, footerTop + 22, { align: 'center', width: 512 });

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
