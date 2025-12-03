const lower = (str) => (str || '').toLowerCase();

const buildCategories = (products = [], categories = []) => {
  const names = categories.length ? categories.map(c => c.name || c).filter(Boolean) : [];
  const collections = names.map((name) => ({
    name,
    items: products.filter(p => lower(p.category) === lower(name))
  }));

  const assignedIds = new Set(collections.flatMap((cat) => cat.items.map((item) => item.id)));
  const uncategorized = products.filter(p => !assignedIds.has(p.id));
  if (uncategorized.length) {
    collections.push({ name: 'Uncategorized', items: uncategorized });
  }
  return collections;
};

const matchesCategory = (product, categoryName) => {
  if (!product || !categoryName) return false;
  return lower(product.category) === lower(categoryName);
};

module.exports = {
  buildCategories,
  matchesCategory,
  CATEGORY_NAMES: []
};
