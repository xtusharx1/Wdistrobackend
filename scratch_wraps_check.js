const { Op } = require('sequelize');
require('dotenv').config();
const sequelize = require('./config/db');
const Product = require('./models/Product');

async function check() {
  try {
    await sequelize.authenticate();
    
    // Find all unique subcategories in database to see if there are spacing or spelling discrepancies
    const subCategories = await Product.findAll({
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('sub_category')), 'sub_category']],
      raw: true
    });
    console.log('All unique subcategories in DB:', subCategories.map(s => s.sub_category));

    // Find all wraps products
    const wrapsProducts = await Product.findAll({
      where: {
        sub_category: {
          [Op.iLike]: '%wrap%'
        }
      }
    });

    console.log(`\nFound ${wrapsProducts.length} products matching '%wrap%':`);
    const countBySubCat = {};
    for (const p of wrapsProducts) {
      countBySubCat[p.sub_category] = (countBySubCat[p.sub_category] || 0) + 1;
    }
    console.log('Count by exact sub_category in database:', countBySubCat);

    // List wraps products status
    const activeWraps = wrapsProducts.filter(p => p.is_active);
    console.log(`Active wraps products: ${activeWraps.length}`);
    console.log(`Inactive wraps products: ${wrapsProducts.length - activeWraps.length}`);

    // Print first 5 wraps products
    console.log('\nSample wraps products in DB:');
    wrapsProducts.slice(0, 5).forEach(p => {
      console.log(`- ID: ${p.id} | Name: ${p.name} | SubCat: ${p.sub_category} | Active: ${p.is_active} | License: ${p.required_license}`);
    });

  } catch (error) {
    console.error(error);
  } finally {
    await sequelize.close();
  }
}

check();
