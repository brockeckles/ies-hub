/**
 * IES Hub v3 — Training Wiki Types
 * JSDoc typedefs for wiki articles, categories, and search.
 *
 * @module hub/training-wiki/types
 */

/**
 * @typedef {Object} WikiCategory
 * @property {string} id
 * @property {string} name
 * @property {string} [icon] — emoji or icon ref
 * @property {number} sortOrder
 * @property {string} [description]
 */

/**
 * @typedef {Object} WikiArticle
 * @property {string} id
 * @property {string} title
 * @property {string} categoryId
 * @property {string} content — markdown or HTML content
 * @property {string} [summary] — short excerpt
 * @property {string[]} tags
 * @property {string} author
 * @property {'draft' | 'published' | 'archived'} status
 * @property {number} viewCount
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

/**
 * @typedef {Object} WikiSearchResult
 * @property {string} articleId
 * @property {string} title
 * @property {string} category
 * @property {string} snippet
 * @property {number} relevance — 0-100
 */

/**
 * @typedef {Object} WikiStats
 * @property {number} totalArticles
 * @property {number} totalCategories
 * @property {number} publishedArticles
 * @property {number} totalViews
 * @property {string} mostViewedArticle
 * @property {string} recentlyUpdated
 */

export {};
