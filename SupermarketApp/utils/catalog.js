const catalog = [
  { label: 'Fresh Produce', keywords: ['apple', 'banana', 'tomato', 'broccoli', 'lettuce', 'berry', 'veg'] },
  { label: 'Bakery & Grains', keywords: ['bread', 'bagel', 'grain', 'rice', 'pasta'] },
  { label: 'Dairy & Drinks', keywords: ['milk', 'cream', 'yogurt', 'juice'] },
  { label: 'Snacks & Pantry', keywords: ['chip', 'snack', 'butter', 'sauce', 'oil', 'powder'] }
];

const CATEGORY_NAMES = [...catalog.map(cat => cat.label), 'Everyday Essentials'];

const lower = (str) => (str || '').toLowerCase();

const buildCategories = (products = []) => {
  const collections = catalog.map((cat) => ({
    name: cat.label,
    items: products.filter((p) => cat.keywords.some((k) => lower(p.productName).includes(k)))
  }));

  const assignedIds = new Set(collections.flatMap((cat) => cat.items.map((item) => item.id)));
  const others = products.filter((p) => !assignedIds.has(p.id));

  if (others.length) {
    collections.push({ name: 'Everyday Essentials', items: others });
  }
  return collections;
};

const matchesCategory = (product, categoryName) => {
  if (!product || !categoryName) return false;
  if (categoryName === 'Everyday Essentials') {
    const keywordMatch = catalog.some((cat) =>
      cat.keywords.some((keyword) => lower(product.productName).includes(keyword))
    );
    return !keywordMatch;
  }

  const category = catalog.find((cat) => cat.label === categoryName);
  if (!category) return false;
  return category.keywords.some((keyword) => lower(product.productName).includes(keyword));
};

module.exports = {
  buildCategories,
  matchesCategory,
  CATEGORY_NAMES
};
