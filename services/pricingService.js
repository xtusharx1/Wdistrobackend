const { Op, literal } = require('sequelize');
const { Product, ProductCollection, ProductVariationGroup } = require('../models');

/**
 * Resolves the effective pricing and deal eligibility for a product or variation.
 *
 * Rules:
 * 1. Checks if the product itself has an eligible deal:
 *    - deal_price > 0 and deal_price < price
 *    - Has a valid product_collection_id with an active collection (is_active === true),
 *      OR is marked clearance with a valid clearance_price.
 *    If eligible, the deal belongs to the individual product/variation.
 *
 * 2. If the product does NOT have its own eligible deal, checks if it belongs to a
 *    ProductVariationGroup and whether the group's parent/primary product has an eligible deal.
 *    - If the parent product has an eligible deal and parent.deal_price < product.price,
 *      the variation qualifies for the parent's deal price.
 *
 * 3. If no valid deal applies (no deal or collection inactive), falls back to regular price
 *    (or active clearance_price if applicable).
 *
 * @param {Object|number} product - Product instance, plain object, or product ID
 * @param {Object|null} [groupParent=null] - Optional pre-loaded parent product instance
 * @returns {Promise<{
 *   deal_price: number|null,
 *   effective_price: number,
 *   has_deal: boolean,
 *   product_collection_id: number|null,
 *   collection_name: string|null,
 *   deal_source: 'individual'|'parent'|null
 * }>}
 */
async function getProductEffectivePricing(product, groupParent = null) {
  let p = product;
  if (typeof product === 'number' || typeof product === 'string') {
    p = await Product.findByPk(parseInt(product, 10), {
      include: [{ model: ProductCollection, as: 'ProductCollection', attributes: ['id', 'name', 'is_active'] }]
    });
    if (!p) {
      throw new Error(`Product with ID ${product} not found`);
    }
  }

  const price = Number(p.price) || 0;

  // 1. Check if the product itself has a valid, eligible deal price
  const rawDealPrice = p.deal_price != null ? Number(p.deal_price) : null;
  const hasValidNumericDeal = rawDealPrice !== null && !isNaN(rawDealPrice) && rawDealPrice > 0 && rawDealPrice < price;

  let ownCollectionActive = false;
  let collectionName = null;

  if (p.ProductCollection) {
    ownCollectionActive = Boolean(p.ProductCollection.is_active);
    collectionName = p.ProductCollection.name || null;
  } else if (p.product_collection_id) {
    const coll = await ProductCollection.findByPk(p.product_collection_id);
    if (coll) {
      ownCollectionActive = Boolean(coll.is_active);
      collectionName = coll.name || null;
    }
  } else if (p.is_clearance && p.clearance_price != null && Number(p.clearance_price) > 0) {
    // Legacy clearance fallback
    ownCollectionActive = true;
    collectionName = 'Clearance';
  }

  if (hasValidNumericDeal && ownCollectionActive) {
    return {
      deal_price: rawDealPrice,
      effective_price: rawDealPrice,
      has_deal: true,
      product_collection_id: p.product_collection_id || null,
      collection_name: collectionName,
      deal_source: 'individual'
    };
  }

  // 2. Check if this product is part of a variation group where the parent product has an eligible deal
  let parent = groupParent;
  if (!parent && p.id) {
    try {
      const group = await ProductVariationGroup.findOne({
        where: literal(`${parseInt(p.id, 10)} = ANY("product_ids")`)
      });
      if (group && Array.isArray(group.product_ids) && group.product_ids.length > 0) {
        const parentId = group.product_ids[0];
        if (parentId !== p.id) {
          parent = await Product.findByPk(parentId, {
            include: [{ model: ProductCollection, as: 'ProductCollection', attributes: ['id', 'name', 'is_active'] }]
          });
        }
      }
    } catch (err) {
      console.error('Error finding variation group parent:', err);
    }
  }

  if (parent && parent.id !== p.id) {
    const parentPricing = await getProductEffectivePricing(parent, parent);
    if (parentPricing.has_deal && parentPricing.deal_price !== null && parentPricing.deal_price < price) {
      return {
        deal_price: parentPricing.deal_price,
        effective_price: parentPricing.deal_price,
        has_deal: true,
        product_collection_id: parentPricing.product_collection_id,
        collection_name: parentPricing.collection_name,
        deal_source: 'parent'
      };
    }
  }

  // 3. Fallback: regular price (or clearance if clearance price applies without collection)
  const isClearance = Boolean(p.is_clearance && p.clearance_price != null && Number(p.clearance_price) > 0 && Number(p.clearance_price) < price);
  const fallbackEffective = isClearance ? Number(p.clearance_price) : price;

  return {
    deal_price: null,
    effective_price: fallbackEffective,
    has_deal: false,
    product_collection_id: p.product_collection_id || null,
    collection_name: collectionName || null,
    deal_source: null
  };
}

module.exports = {
  getProductEffectivePricing
};
