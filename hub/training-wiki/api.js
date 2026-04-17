/**
 * IES Hub v3 — Training Wiki API / Persistence
 * Supabase interactions for wiki articles and categories.
 *
 * @module hub/training-wiki/api
 */

import { db } from '../../shared/supabase.js?v=20260417-m7';

/**
 * List all categories.
 * @returns {Promise<import('./types.js?v=20260417-m7').WikiCategory[]>}
 */
export async function listCategories() {
  const { data, error } = await db.from('wiki_categories').select('*').order('sort_order');
  if (error) throw error;
  return data || [];
}

/**
 * List articles, optionally filtered.
 * @param {{ categoryId?: string, status?: string }} [filters]
 * @returns {Promise<import('./types.js?v=20260417-m7').WikiArticle[]>}
 */
export async function listArticles(filters = {}) {
  let query = db.from('wiki_articles').select('*');
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters.status) query = query.eq('status', filters.status);
  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get a single article.
 * @param {string} id
 * @returns {Promise<import('./types.js?v=20260417-m7').WikiArticle|null>}
 */
export async function getArticle(id) {
  return db.fetchById('wiki_articles', id);
}

/**
 * Save (insert or update) an article.
 * @param {import('./types.js?v=20260417-m7').WikiArticle} article
 * @returns {Promise<import('./types.js?v=20260417-m7').WikiArticle>}
 */
export async function saveArticle(article) {
  const payload = {
    title: article.title,
    category_id: article.categoryId,
    content: article.content,
    summary: article.summary || '',
    tags: article.tags || [],
    author: article.author || 'Anonymous',
    status: article.status || 'draft',
  };
  if (article.id) return db.update('wiki_articles', article.id, payload);
  return db.insert('wiki_articles', payload);
}

/**
 * Delete an article.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteArticle(id) {
  await db.remove('wiki_articles', id);
}

/**
 * Increment view count.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function incrementViews(id) {
  await db.from('wiki_articles').update({ view_count: db.raw('view_count + 1') }).eq('id', id);
}

/**
 * Load all wiki data.
 * @returns {Promise<{ categories: import('./types.js?v=20260417-m7').WikiCategory[], articles: import('./types.js?v=20260417-m7').WikiArticle[] }>}
 */
export async function loadRefData() {
  const [categories, articles] = await Promise.all([listCategories(), listArticles()]);
  return { categories, articles };
}
